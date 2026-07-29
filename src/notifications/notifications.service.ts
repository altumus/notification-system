import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';

import { AppConfigService } from '../common/config/app-config.service.js';
import { newUuidV7 } from '../common/utils/uuid-v7.js';
import { KyselyService } from '../database/kysely.service.js';
import { withTransaction } from '../database/transaction.helper.js';

import { buildDedupHash } from './domain/dedup-hash.js';
import { RateLimitExceededError } from './domain/errors.js';
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
}

/**
 * Полезная нагрузка события notification.created.
 */
export type NotificationCreatedPayload = Notification;
