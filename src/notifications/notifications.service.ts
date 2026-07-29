import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';

import { AppConfigService } from '../common/config/app-config.service.js';
import { decodeKeysetCursor, encodeKeysetCursor } from '../common/pagination/keyset-cursor.js';
import { assertUuidV7, newUuidV7, uuidV7ToDate } from '../common/utils/uuid-v7.js';
import { KyselyService } from '../database/kysely.service.js';
import { withTransaction } from '../database/transaction.helper.js';

import { buildDedupHash } from './domain/dedup-hash.js';
import { NotificationNotFoundError, RateLimitExceededError } from './domain/errors.js';
import { NotificationTypeConfig } from './domain/notification-type.config.js';
import type { CreateNotificationResult, Notification } from './domain/notification.entity.js';
import { mapNotificationRow } from './domain/notification.mapper.js';
import { NotificationsRepository } from './notifications.repository.js';

/**
 * Вход создания уведомления (уже провалидированный на границе).
 */
export interface CreateNotificationInput {
  userId: string;
  type: string;
  payload: Record<string, unknown>;
}

/**
 * Имя доменного события после успешного COMMIT создания.
 *
 * Зачем: WS-доставка подписывается на это событие в коммите 13; create не знает про сокеты.
 */
export const NOTIFICATION_CREATED_EVENT = 'notification.created';

/**
 * Событие синхронизации прочтения между вкладками (подписчик WS — коммит 13).
 */
export const NOTIFICATION_READ_EVENT = 'notification.read';

/** Размер чанка markAllAsRead — короткие транзакции вместо одного огромного UPDATE. */
const MARK_ALL_CHUNK_SIZE = 10_000;

/**
 * Бизнес-правила создания уведомлений (dedup + rate limit).
 *
 * Зачем: закрывает R5/R6/R3 одной транзакцией из §3.4 плана.
 * Как: advisory-lock → поиск якоря → rate-limit → insert; WS-событие только после COMMIT.
 */
@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);
  private readonly typeConfig: NotificationTypeConfig;

  /**
   * Создаёт сервис уведомлений.
   *
   * @param kyselyService - доступ к БД
   * @param repository - SQL-операции
   * @param config - env-конфиг
   * @param eventEmitter - шина доменных событий
   */
  public constructor(
    private readonly kyselyService: KyselyService,
    private readonly repository: NotificationsRepository,
    private readonly config: AppConfigService,
    private readonly eventEmitter: EventEmitter2,
  ) {
    this.typeConfig = NotificationTypeConfig.withDemoTypes({
      rateLimit: config.notificationsRateLimit,
      rateWindowMs: config.notificationsRateWindowMs,
      dedupWindowMs: config.notificationsDedupWindowMs,
    });
  }

  /**
   * Создаёт уведомление или схлопывает дубль в существующее.
   *
   * Зачем: атомарно закрывает R5 (лимит) и R6 (дедуп) без гонок между инстансами.
   * Как: последовательность §3.4 внутри withTransaction; EventEmitter2.emit после COMMIT —
   * подписчик realtime появится в коммите 13. Схлопывание не публикует событие (нет повторного push).
   *
   * @param input - userId, type, payload
   * @returns Discriminated union created | deduplicated
   * @throws {RateLimitExceededError} Если превышен лимит принятых уведомлений в окне
   */
  public async create(input: CreateNotificationInput): Promise<CreateNotificationResult> {
    const started = Date.now();
    const typeSettings = this.typeConfig.resolve(input.type);
    const dedupHash = buildDedupHash({
      userId: input.userId,
      type: input.type,
      payload: input.payload,
      ...(typeSettings.dedupKeys === undefined ? {} : { dedupKeys: typeSettings.dedupKeys }),
    });

    const result = await withTransaction(this.kyselyService.db, async (trx) => {
      const { now } = await this.repository.acquireUserTypeLock(trx, input.userId, input.type);
      const msecs = Math.floor(now.getTime());
      const createdAt = new Date(msecs);

      const windowStart = new Date(msecs - typeSettings.dedupWindowMs);
      const anchor = await this.repository.findDedupAnchor(
        trx,
        input.userId,
        input.type,
        dedupHash,
        windowStart,
      );

      if (anchor !== null) {
        const updated = await this.repository.incrementOccurrences(
          trx,
          anchor.id,
          anchor.created_at,
          createdAt,
        );
        return { status: 'deduplicated' as const, notification: mapNotificationRow(updated) };
      }

      const rateWindowStart = new Date(msecs - typeSettings.rateWindowMs);
      const { used, oldest } = await this.repository.countInRateWindow(
        trx,
        input.userId,
        input.type,
        rateWindowStart,
      );

      if (used >= typeSettings.rateLimit) {
        const retryAfterMs =
          oldest === null
            ? typeSettings.rateWindowMs
            : Math.max(1, oldest.getTime() + typeSettings.rateWindowMs - msecs);
        throw new RateLimitExceededError(
          input.type,
          typeSettings.rateLimit,
          typeSettings.rateWindowMs,
          retryAfterMs,
        );
      }

      const id = newUuidV7(msecs);
      const inserted = await this.repository.insert(trx, {
        id,
        userId: input.userId,
        type: input.type,
        payload: input.payload,
        dedupHash,
        createdAt,
      });
      return { status: 'created' as const, notification: mapNotificationRow(inserted) };
    });

    const durationMs = Date.now() - started;
    if (result.status === 'created') {
      this.logger.log({
        outcome: 'created',
        userId: input.userId,
        type: input.type,
        notificationId: result.notification.id,
        durationMs,
      });
      // Только после COMMIT: realtime подпишется в коммите 13.
      this.eventEmitter.emit(NOTIFICATION_CREATED_EVENT, result.notification);
    } else {
      this.logger.log({
        outcome: 'deduplicated',
        userId: input.userId,
        type: input.type,
        notificationId: result.notification.id,
        occurrences: result.notification.occurrences,
        durationMs,
      });
    }

    return result;
  }

  /**
   * Доступ к реестру типов (для демо и будущих контроллеров).
   *
   * @returns NotificationTypeConfig
   */
  public getTypeConfig(): NotificationTypeConfig {
    return this.typeConfig;
  }

  /**
   * Помечает уведомление прочитанным (идемпотентно).
   *
   * Зачем: R1 — mark as read; одинаковый 404 для чужого и отсутствующего (анти-IDOR).
   * Как: created_at из UUIDv7 → UPDATE одной партиции; при 0 строк — SELECT для идемпотентности.
   *
   * @param userId - владелец из токена
   * @param id - id уведомления (UUIDv7)
   * @returns Актуальная доменная сущность
   * @throws {NotificationNotFoundError} Если нет или чужое
   * @throws {Error} Если id не UUIDv7
   */
  public async markAsRead(userId: string, id: string): Promise<Notification> {
    assertUuidV7(id);
    const createdAt = uuidV7ToDate(id);
    const updated = await this.repository.markAsReadIfUnread(
      this.kyselyService.db,
      userId,
      id,
      createdAt,
    );
    if (updated !== null) {
      const notification = mapNotificationRow(updated);
      this.eventEmitter.emit(NOTIFICATION_READ_EVENT, {
        userId,
        id: notification.id,
        readAt: notification.readAt,
      });
      return notification;
    }
    const existing = await this.repository.findByIdForUser(
      this.kyselyService.db,
      userId,
      id,
      createdAt,
    );
    if (existing === null) {
      throw new NotificationNotFoundError(id);
    }
    return mapNotificationRow(existing);
  }

  /**
   * Помечает все непрочитанные пользователя прочитанными.
   *
   * Зачем: R1 bulk-read; чанки по 10k не держат длинную транзакцию и не раздувают WAL.
   * Как: цикл UPDATE … LIMIT chunk, пока затронуто > 0; окно по retentionMonths.
   *
   * @param userId - владелец
   * @returns Число обновлённых строк
   */
  public async markAllAsRead(userId: string): Promise<{ updated: number }> {
    const retentionStart = new Date();
    retentionStart.setUTCMonth(retentionStart.getUTCMonth() - this.config.retentionMonths);
    let updated = 0;
    for (;;) {
      const chunk = await this.repository.markAllAsReadChunk(
        this.kyselyService.db,
        userId,
        retentionStart,
        MARK_ALL_CHUNK_SIZE,
      );
      updated += chunk;
      if (chunk < MARK_ALL_CHUNK_SIZE) {
        break;
      }
    }
    return { updated };
  }

  /**
   * Список непрочитанных с keyset-пагинацией.
   *
   * @param userId - владелец
   * @param limit - размер страницы 1..100
   * @param cursor - opaque-курсор или undefined
   * @returns items, nextCursor, unreadCount (+ exact)
   */
  public async listUnread(
    userId: string,
    limit: number,
    cursor: string | undefined,
  ): Promise<{
    items: Notification[];
    nextCursor: string | null;
    unreadCount: number;
    unreadCountExact: boolean;
  }> {
    const cursorPayload =
      cursor === undefined || cursor.length === 0 ? undefined : decodeKeysetCursor(cursor);
    const rows = await this.repository.listUnread(
      this.kyselyService.db,
      userId,
      limit,
      cursorPayload,
    );
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];
    const nextCursor =
      hasMore && last !== undefined
        ? encodeKeysetCursor({ createdAt: last.created_at, id: last.id })
        : null;
    const { count, exact } = await this.repository.countUnread(this.kyselyService.db, userId, 1000);
    return {
      items: page.map(mapNotificationRow),
      nextCursor,
      unreadCount: count,
      unreadCountExact: exact,
    };
  }

  /**
   * Счётчик непрочитанных для бейджа.
   *
   * @param userId - владелец
   * @param cap - порог «N+»
   * @returns count и exact
   */
  public async countUnread(userId: string, cap = 1000): Promise<{ count: number; exact: boolean }> {
    return this.repository.countUnread(this.kyselyService.db, userId, cap);
  }
}

/**
 * Полезная нагрузка события notification.created.
 */
export type NotificationCreatedPayload = Notification;
