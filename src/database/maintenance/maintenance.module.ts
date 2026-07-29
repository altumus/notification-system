import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';

import { PartitionMaintenanceService } from './partition-maintenance.service.js';
import { RetentionService } from './retention.service.js';

/**
 * Нужен ли ScheduleModule в этом процессе.
 *
 * Зачем: в Jest cron-таймеры (`node-cron` / `@nestjs/schedule`) оставляют open handles
 * и тест «висит» после PASS. Выключаем через `CRON_ENABLED=false` в globalSetup.
 * Как: читаем process.env до регистрации модуля (до DI) — тот же источник, что Zod-схема.
 *
 * @returns true, если cron можно поднимать
 */
function isCronEnabled(): boolean {
  return process.env['CRON_ENABLED'] !== 'false';
}

/**
 * Модуль обслуживания партиций и retention таблицы `notifications`.
 *
 * Зачем: изолирует фоновые cron-задачи (создание партиций наперёд, удаление устаревших)
 * от бизнес-модулей уведомлений.
 * Как: подключает `ScheduleModule.forRoot()` (единственное место в приложении, где он нужен)
 * и регистрирует сервисы обслуживания; `KyselyService`/`AppConfigService` приходят из глобальных
 * `DatabaseModule`/`AppConfigModule`. При `CRON_ENABLED=false` ScheduleModule не импортируется —
 * `@Cron` на провайдерах становится no-op, bootstrap `ensurePartitions` по-прежнему вызывается.
 */
@Module({
  imports: isCronEnabled() ? [ScheduleModule.forRoot()] : [],
  providers: [PartitionMaintenanceService, RetentionService],
})
export class MaintenanceModule {}
