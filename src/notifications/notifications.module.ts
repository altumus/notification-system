import { Module } from '@nestjs/common';

import { NotificationsController } from './notifications.controller.js';
import { NotificationsRepository } from './notifications.repository.js';
import { NotificationsService } from './notifications.service.js';

/**
 * Модуль домена уведомлений.
 *
 * Зачем: изолирует create/read и REST от realtime-инфраструктуры.
 * Как: controller + repository + service; EventEmitter2 из глобального EventEmitterModule.
 */
@Module({
  controllers: [NotificationsController],
  providers: [NotificationsRepository, NotificationsService],
  exports: [NotificationsService, NotificationsRepository],
})
export class NotificationsModule {}
