import { Module } from '@nestjs/common';

import { AppConfigModule } from './common/config/config.module.js';
import { AppLoggingModule } from './common/logging/logging.module.js';
import { HealthModule } from './health/health.module.js';

/**
 * Корневой модуль приложения.
 *
 * Зачем: собирает инфраструктурные модули до появления доменных (notifications, realtime).
 * Как: подключает конфиг, логи и health; бизнес-модули добавятся в следующих коммитах.
 */
@Module({
  imports: [AppConfigModule, AppLoggingModule, HealthModule],
})
export class AppModule {}
