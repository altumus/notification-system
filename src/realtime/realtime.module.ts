import { Module } from '@nestjs/common';

import { NotificationsModule } from '../notifications/notifications.module.js';

import { NotificationsGateway } from './notifications.gateway.js';
import { InMemoryPresenceRegistry, PRESENCE_REGISTRY } from './presence.registry.js';

/**
 * Модуль realtime (Socket.IO).
 *
 * Зачем: изолирует gateway/presence от HTTP API; delivery появится в коммите 13.
 * Как: NotificationsGateway + in-memory PresenceRegistry за токеном PRESENCE_REGISTRY.
 */
@Module({
  imports: [NotificationsModule],
  providers: [
    NotificationsGateway,
    { provide: PRESENCE_REGISTRY, useClass: InMemoryPresenceRegistry },
  ],
  exports: [PRESENCE_REGISTRY, NotificationsGateway],
})
export class RealtimeModule {}
