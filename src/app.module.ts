import { Module } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';

import { AuthModule } from './auth/auth.module.js';
import { AppConfigModule } from './common/config/config.module.js';
import { AppLoggingModule } from './common/logging/logging.module.js';
import { RateLimitModule } from './common/rate-limit/rate-limit.module.js';
import { DatabaseModule } from './database/database.module.js';
import { MaintenanceModule } from './database/maintenance/maintenance.module.js';
import { HealthModule } from './health/health.module.js';
import { NotificationsModule } from './notifications/notifications.module.js';
import { RealtimeModule } from './realtime/realtime.module.js';

/**
 * Корневой модуль приложения.
 *
 * Зачем: собирает инфраструктурные и доменные модули.
 * Как: конфиг, логи, rate limit, auth, БД, maintenance, notifications, realtime, health.
 *
 * Порядок imports значим: APP_GUARD регистрируются в порядке модулей, поэтому RateLimitModule
 * стоит перед AuthModule — лимит частоты отсекает флуд раньше проверки JWT.
 */
@Module({
  imports: [
    AppConfigModule,
    AppLoggingModule,
    EventEmitterModule.forRoot(),
    RateLimitModule,
    AuthModule,
    DatabaseModule,
    MaintenanceModule,
    NotificationsModule,
    RealtimeModule,
    HealthModule,
  ],
})
export class AppModule {}
