import { Module } from '@nestjs/common';

import { AppConfigModule } from './common/config/config.module.js';
import { AppLoggingModule } from './common/logging/logging.module.js';
import { DatabaseModule } from './database/database.module.js';
import { HealthModule } from './health/health.module.js';

/**
 * Корневой модуль приложения.
 *
 * Зачем: собирает инфраструктурные модули до появления доменных (notifications, realtime).
 * Как: подключает конфиг, логи, доступ к БД и health; обслуживание партиций — в коммите 05.
 */
@Module({
  imports: [AppConfigModule, AppLoggingModule, DatabaseModule, HealthModule],
})
export class AppModule {}
