import { Injectable, Logger } from '@nestjs/common';
import type { Socket } from 'socket.io';

import { AppConfigService } from '../common/config/app-config.service.js';
import { KyselyService } from '../database/kysely.service.js';
import { mapNotificationRow } from '../notifications/domain/notification.mapper.js';
import { NotificationsRepository } from '../notifications/notifications.repository.js';

import { DeliveredBatchWriter } from './delivered-batch.writer.js';
import { DeliveryMetrics } from './delivery.metrics.js';
import { toNotificationWsDto } from './notification-ws.mapper.js';

/**
 * Payload события `notification.backlog`.
 */
export interface NotificationBacklogPayload {
  items: ReturnType<typeof toNotificationWsDto>[];
  batch: number;
  hasMore: boolean;
}

/**
 * Догон недоставленных при подключении (R9).
 *
 * Зачем: офлайн-клиент не теряет уведомления — при реконнекте получает backlog с ack.
 * Как: страницы ASC по created_at; следующая страница только после ack (backpressure);
 * лимит страниц — остаток клиент дотягивает через `notification.fetchUnread`.
 */
@Injectable()
export class BacklogReplayer {
  private readonly logger = new Logger(BacklogReplayer.name);

  /**
   * Создаёт replayer.
   *
   * @param kysely - БД
   * @param repository - listUndelivered
   * @param deliveredBatch - батч записи delivered_at
   * @param config - размеры страниц и ack timeout
   * @param metrics - хуки счётчиков
   */
  public constructor(
    private readonly kysely: KyselyService,
    private readonly repository: NotificationsRepository,
    private readonly deliveredBatch: DeliveredBatchWriter,
    private readonly config: AppConfigService,
    private readonly metrics: DeliveryMetrics,
  ) {}

  /**
   * Реплеит недоставленные в фоне для сокета.
   *
   * Зачем: не блокировать `handleConnection` / `connection.ready`.
   * Как: цикл страниц с проверкой `socket.connected`; при `WS_BACKLOG_MAX_PAGES`
   * и хвосте в БД — последняя страница с `hasMore: true`.
   *
   * @param socket - авторизованный сокет
   * @param userId - владелец
   * @returns void
   */
  public async replay(socket: Socket, userId: string): Promise<void> {
    const batchSize = this.config.wsBacklogBatchSize;
    const maxPages = this.config.wsBacklogMaxPages;
    const retentionStart = this.retentionStart();
    let cursor: { createdAt: Date; id: string } | undefined;
    let batch = 0;

    while (socket.connected && batch < maxPages) {
      const rows = await this.repository.listUndelivered(
        this.kysely.db,
        userId,
        batchSize,
        retentionStart,
        cursor,
      );
      if (rows.length === 0) {
        return;
      }

      const hasMoreInDb = rows.length > batchSize;
      const page = hasMoreInDb ? rows.slice(0, batchSize) : rows;
      batch += 1;
      const isLastAllowedPage = batch >= maxPages;
      const payload: NotificationBacklogPayload = {
        items: page.map((row) => toNotificationWsDto(mapNotificationRow(row))),
        batch,
        // true, если после этой страницы в БД ещё есть недоставленные.
        hasMore: hasMoreInDb,
      };

      try {
        await socket
          .timeout(this.config.wsAckTimeoutMs)
          .emitWithAck('notification.backlog', payload);
      } catch (error) {
        this.logger.warn(
          { socketId: socket.id, userId, batch, err: error },
          'Backlog ack timeout/ошибка — прекращаю реплей (at-least-once)',
        );
        this.metrics.ackTimeout();
        return;
      }

      this.deliveredBatch.enqueueMany(page.map((row) => row.id));
      for (let i = 0; i < page.length; i += 1) {
        this.metrics.delivered();
      }

      const last = page[page.length - 1];
      if (last === undefined) {
        return;
      }
      cursor = { createdAt: last.created_at, id: last.id };

      if (!hasMoreInDb) {
        return;
      }
      if (isLastAllowedPage) {
        this.logger.log(
          { userId, socketId: socket.id, pages: batch },
          'Backlog обрезан по WS_BACKLOG_MAX_PAGES — остаток через fetchUnread',
        );
        return;
      }
    }
  }

  /**
   * Нижняя граница выборки по retention.
   *
   * @returns Дата начала окна хранения
   */
  private retentionStart(): Date {
    const start = new Date();
    start.setUTCMonth(start.getUTCMonth() - this.config.retentionMonths);
    return start;
  }
}
