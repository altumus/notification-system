import { Module } from '@nestjs/common';

import { AppConfigModule } from './common/config/config.module.js';
import { AppLoggingModule } from './common/logging/logging.module.js';
import { DatabaseModule } from './database/database.module.js';
import { MaintenanceModule } from './database/maintenance/maintenance.module.js';
import { HealthModule } from './health/health.module.js';

/**
 * Корневой модуль приложения.
 *
 * Зачем: собирает инфраструктурные модули до появления доменных (notifications, realtime).
 * Как: подключает конфиг, логи, доступ к БД, обслуживание партиций и health; бизнес-модули
 * уведомлений добавятся в следующих коммитах.
 */
@Module({
  imports: [AppConfigModule, AppLoggingModule, DatabaseModule, MaintenanceModule, HealthModule],
})
export class AppModule {}
