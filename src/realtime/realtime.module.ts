import { Module } from '@nestjs/common';

import { NotificationsModule } from '../notifications/notifications.module.js';

import { BacklogReplayer } from './backlog.replayer.js';
import { DeliveredBatchWriter } from './delivered-batch.writer.js';
import { DeliveryDispatcher } from './delivery.dispatcher.js';
import { DeliveryMetrics } from './delivery.metrics.js';
import { NotificationsGateway } from './notifications.gateway.js';
import { InMemoryPresenceRegistry, PRESENCE_REGISTRY } from './presence.registry.js';
import { UndeliveredSweeper } from './undelivered.sweeper.js';

/**
 * Модуль realtime (Socket.IO + delivery + backlog/sweeper).
 *
 * Зачем: изолирует gateway/presence/push от HTTP API.
 * Как: PresenceRegistry за токеном; DeliveryDispatcher после COMMIT;
 * BacklogReplayer на connect; UndeliveredSweeper для потерянных ack.
 */
@Module({
  imports: [NotificationsModule],
  providers: [
    NotificationsGateway,
    { provide: PRESENCE_REGISTRY, useClass: InMemoryPresenceRegistry },
    DeliveredBatchWriter,
    DeliveryMetrics,
    DeliveryDispatcher,
    BacklogReplayer,
    UndeliveredSweeper,
  ],
  exports: [
    PRESENCE_REGISTRY,
    NotificationsGateway,
    DeliveredBatchWriter,
    DeliveryMetrics,
    UndeliveredSweeper,
  ],
})
export class RealtimeModule {}
