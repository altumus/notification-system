import { Inject, Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';

import type { Notification } from '../notifications/domain/notification.entity.js';
import {
  NOTIFICATION_CREATED_EVENT,
  NOTIFICATION_READ_EVENT,
} from '../notifications/notifications.service.js';

import { DeliveredBatchWriter } from './delivered-batch.writer.js';
import { DeliveryMetrics } from './delivery.metrics.js';
import { NotificationsGateway } from './notifications.gateway.js';
import { type PresenceRegistry, PRESENCE_REGISTRY } from './presence.registry.js';

/**
 * Полезная нагрузка события notification.read.
 */
export interface NotificationReadEventPayload {
  userId: string;
  id: string;
  readAt: Date | null;
}

/**
 * Диспетчер realtime-доставки после доменных событий.
 *
 * Зачем: create/read в HTTP не зависят от Socket.IO; push — side-effect после COMMIT.
 * Как: presence → gateway.emitWithAck → при ack батч markDelivered; иначе sweeper (14).
 *
 * At-least-once (не at-most-once): при таймауте ack `delivered_at` остаётся NULL и событие
 * будет повторено sweeper/backlog. Потеря «тишины» хуже дубля на клиенте (клиент идемпотентен по id).
 */
@Injectable()
export class DeliveryDispatcher {
  private readonly logger = new Logger(DeliveryDispatcher.name);

  /**
   * Создаёт диспетчер.
   *
   * @param presence - онлайн-реестр
   * @param gateway - Socket.IO push
   * @param deliveredBatch - батч markDelivered
   * @param metrics - хуки счётчиков
   */
  public constructor(
    @Inject(PRESENCE_REGISTRY) private readonly presence: PresenceRegistry,
    private readonly gateway: NotificationsGateway,
    private readonly deliveredBatch: DeliveredBatchWriter,
    private readonly metrics: DeliveryMetrics,
  ) {}

  /**
   * Пушит новое уведомление онлайн-клиентам.
   *
   * @param notification - сущность после COMMIT create
   * @returns void
   */
  @OnEvent(NOTIFICATION_CREATED_EVENT)
  public async onNotificationCreated(notification: Notification): Promise<void> {
    if (!this.presence.isOnline(notification.userId)) {
      this.metrics.pushSkippedOffline();
      this.logger.debug(
        { userId: notification.userId, id: notification.id },
        'Push пропущен: пользователь офлайн',
      );
      return;
    }

    const acked = await this.gateway.deliverCreated(notification);
    if (acked) {
      this.deliveredBatch.enqueue(notification.id);
      this.metrics.delivered();
      return;
    }
    this.metrics.ackTimeout();
    this.logger.warn(
      { userId: notification.userId, id: notification.id },
      'Ack timeout/ошибка — delivered_at не ставим (at-least-once)',
    );
  }

  /**
   * Рассылает прочтение по всем сокетам пользователя (вкладки).
   *
   * @param payload - id и readAt
   * @returns void
   */
  @OnEvent(NOTIFICATION_READ_EVENT)
  public onNotificationRead(payload: NotificationReadEventPayload): void {
    this.gateway.broadcastRead({
      id: payload.id,
      userId: payload.userId,
      readAt: payload.readAt?.toISOString() ?? null,
    });
  }
}
