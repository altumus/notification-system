import { Module } from '@nestjs/common';

import { IdempotencyInterceptor } from './idempotency/idempotency.interceptor.js';
import { IdempotencyRepository } from './idempotency/idempotency.repository.js';
import { IdempotencyService } from './idempotency/idempotency.service.js';
import { NotificationsController } from './notifications.controller.js';
import { NotificationsRepository } from './notifications.repository.js';
import { NotificationsService } from './notifications.service.js';

/**
 * Модуль домена уведомлений.
 *
 * Зачем: изолирует create/read и REST от realtime-инфраструктуры.
 * Как: controller + repository + service + Idempotency-Key; EventEmitter2 из глобального модуля.
 */
@Module({
  controllers: [NotificationsController],
  providers: [
    NotificationsRepository,
    NotificationsService,
    IdempotencyRepository,
    IdempotencyService,
    IdempotencyInterceptor,
  ],
  exports: [NotificationsService, NotificationsRepository, IdempotencyService],
})
export class NotificationsModule {}
