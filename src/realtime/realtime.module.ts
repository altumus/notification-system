import { Module } from '@nestjs/common';

import { NotificationsModule } from '../notifications/notifications.module.js';

import { DeliveredBatchWriter } from './delivered-batch.writer.js';
import { DeliveryDispatcher } from './delivery.dispatcher.js';
import { DeliveryMetrics } from './delivery.metrics.js';
import { NotificationsGateway } from './notifications.gateway.js';
import { InMemoryPresenceRegistry, PRESENCE_REGISTRY } from './presence.registry.js';

/**
 * Модуль realtime (Socket.IO + delivery).
 *
 * Зачем: изолирует gateway/presence/push от HTTP API.
 * Как: PresenceRegistry за токеном; DeliveryDispatcher слушает доменные события.
 */
@Module({
  imports: [NotificationsModule],
  providers: [
    NotificationsGateway,
    { provide: PRESENCE_REGISTRY, useClass: InMemoryPresenceRegistry },
    DeliveredBatchWriter,
    DeliveryMetrics,
    DeliveryDispatcher,
  ],
  exports: [PRESENCE_REGISTRY, NotificationsGateway, DeliveredBatchWriter, DeliveryMetrics],
})
export class RealtimeModule {}
