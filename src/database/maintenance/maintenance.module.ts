import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';

import { PartitionMaintenanceService } from './partition-maintenance.service.js';
import { RetentionService } from './retention.service.js';

/**
 * Модуль обслуживания партиций и retention таблицы `notifications`.
 *
 * Зачем: изолирует фоновые cron-задачи (создание партиций наперёд, удаление устаревших)
 * от бизнес-модулей уведомлений.
 * Как: подключает `ScheduleModule.forRoot()` (единственное место в приложении, где он нужен)
 * и регистрирует сервисы обслуживания; `KyselyService`/`AppConfigService` приходят из глобальных
 * `DatabaseModule`/`AppConfigModule`.
 */
@Module({
  imports: [ScheduleModule.forRoot()],
  providers: [PartitionMaintenanceService, RetentionService],
})
export class MaintenanceModule {}
