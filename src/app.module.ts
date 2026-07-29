import { Module } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';

import { AppConfigModule } from './common/config/config.module.js';
import { AppLoggingModule } from './common/logging/logging.module.js';
import { DatabaseModule } from './database/database.module.js';
import { MaintenanceModule } from './database/maintenance/maintenance.module.js';
import { HealthModule } from './health/health.module.js';
import { NotificationsModule } from './notifications/notifications.module.js';

/**
 * Корневой модуль приложения.
 *
 * Зачем: собирает инфраструктурные и доменные модули.
 * Как: конфиг, логи, БД, maintenance, notifications, health; realtime — в коммитах 12+.
 */
@Module({
  imports: [
    AppConfigModule,
    AppLoggingModule,
    EventEmitterModule.forRoot(),
    DatabaseModule,
    MaintenanceModule,
    NotificationsModule,
    HealthModule,
  ],
})
export class AppModule {}
