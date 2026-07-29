import { Module } from '@nestjs/common';

import { NotificationsRepository } from './notifications.repository.js';
import { NotificationsService } from './notifications.service.js';

/**
 * Модуль домена уведомлений.
 *
 * Зачем: изолирует create/read от инфраструктуры; REST и WS подключатся в следующих коммитах.
 * Как: регистрирует repository + service; EventEmitter2 приходит из глобального EventEmitterModule.
 */
@Module({
  providers: [NotificationsRepository, NotificationsService],
  exports: [NotificationsService, NotificationsRepository],
})
export class NotificationsModule {}
