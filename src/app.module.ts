import { Module } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';

import { AuthModule } from './auth/auth.module.js';
import { AppConfigModule } from './common/config/config.module.js';
import { AppLoggingModule } from './common/logging/logging.module.js';
import { DatabaseModule } from './database/database.module.js';
import { MaintenanceModule } from './database/maintenance/maintenance.module.js';
import { HealthModule } from './health/health.module.js';
import { NotificationsModule } from './notifications/notifications.module.js';
import { RealtimeModule } from './realtime/realtime.module.js';

/**
 * Корневой модуль приложения.
 *
 * Зачем: собирает инфраструктурные и доменные модули.
 * Как: конфиг, логи, auth, БД, maintenance, notifications, realtime, health.
 */
@Module({
  imports: [
    AppConfigModule,
    AppLoggingModule,
    EventEmitterModule.forRoot(),
    AuthModule,
    DatabaseModule,
    MaintenanceModule,
    NotificationsModule,
    RealtimeModule,
    HealthModule,
  ],
})
export class AppModule {}
