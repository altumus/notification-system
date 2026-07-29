import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { sql, type Transaction } from 'kysely';

import { AppConfigService } from '../../common/config/app-config.service.js';
import { KyselyService } from '../kysely.service.js';
import type { Database } from '../schema.types.js';
import { withTransaction } from '../transaction.helper.js';

/**
 * Ключ advisory-лока обслуживания партиций (хешируется в bigint через hashtextextended).
 *
 * Зачем: при нескольких инстансах приложения ежедневная джоба не должна выполняться параллельно
 * на каждом из них — это бессмысленная нагрузка на БД.
 */
const PARTITION_MAINTENANCE_LOCK_KEY = 'notifications:partition-maintenance';

/**
 * Создаёт и поддерживает партиции таблицы `notifications` наперёд.
 *
 * Зачем: без автосоздания партиций вставки через несколько месяцев начнут падать либо молча
 * оседать в `notifications_default`, теряя partition pruning — при 500k уведомлений/сутки
 * это происходит быстро.
 * Как: раз в сутки (и один раз сразу при старте приложения) гарантирует наличие партиций на
 * `PARTITION_LOOKAHEAD_MONTHS` месяцев вперёд через идемпотентную SQL-функцию
 * `ensure_notifications_partition`, а также проверяет, не появились ли строки в
 * `notifications_default` — это верный признак того, что автосоздание отстало от реальности.
 */
@Injectable()
export class PartitionMaintenanceService implements OnApplicationBootstrap {
  private readonly logger = new Logger(PartitionMaintenanceService.name);

  /**
   * Создаёт сервис обслуживания партиций.
   *
   * @param kyselyService - типизированный доступ к БД
   * @param config - конфигурация приложения (лимит опережающих месяцев)
   */
  public constructor(
    private readonly kyselyService: KyselyService,
    private readonly config: AppConfigService,
  ) {}

  /**
   * Гарантирует наличие партиций сразу после старта приложения.
   *
   * Зачем: ждать первого срабатывания суточного cron нельзя — если приложение упало и
   * поднялось в первый день нового месяца перед плановым запуском джобы, новые уведомления
   * должны сразу иметь партицию, а не улетать в `notifications_default`.
   *
   * @returns Promise, завершающийся после проверки/создания партиций
   */
  public async onApplicationBootstrap(): Promise<void> {
    await this.ensurePartitions();
  }

  /**
   * Ежедневно гарантирует наличие партиций на N месяцев вперёд.
   *
   * Зачем: закрывает R4 (500k/сутки) на горизонте месяцев — без этого партиционирование
   * потеряло бы смысл через `PARTITION_LOOKAHEAD_MONTHS` месяцев эксплуатации.
   * Как: под advisory-локом транзакции (безопасен для пула соединений — снимается сам при
   * COMMIT/ROLLBACK) вызывает `ensure_notifications_partition` для текущего и `lookahead`
   * следующих месяцев; функция идемпотентна (`CREATE TABLE IF NOT EXISTS`), поэтому повторный
   * запуск не создаёт дублей и не является ошибкой.
   *
   * @returns Promise, завершающийся после обслуживания партиций текущим инстансом
   */
  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  public async ensurePartitions(): Promise<void> {
    await withTransaction(this.kyselyService.db, async (trx) => {
      const lockAcquired = await this.tryAcquireLock(trx);
      if (!lockAcquired) {
        this.logger.debug('Обслуживание партиций уже выполняется другим инстансом, пропускаю');
        return;
      }

      const monthsAhead = this.config.partitionLookaheadMonths;
      for (let offset = 0; offset <= monthsAhead; offset += 1) {
        const partitionName = await this.ensurePartitionForMonthOffset(trx, offset);
        this.logger.log(`Партиция готова: ${partitionName}`);
      }

      await this.warnIfDefaultPartitionUsed(trx);
    });
  }

  /**
   * Пытается получить транзакционный advisory-лок обслуживания партиций.
   *
   * @param trx - активная транзакция
   * @returns true, если лок получен этим вызовом
   */
  private async tryAcquireLock(trx: Transaction<Database>): Promise<boolean> {
    const result = await sql<{ locked: boolean }>`
      select pg_try_advisory_xact_lock(hashtextextended(${PARTITION_MAINTENANCE_LOCK_KEY}, 0)) as locked
    `.execute(trx);
    return result.rows[0]?.locked === true;
  }

  /**
   * Гарантирует наличие партиции для месяца, отстоящего от текущего на `offset` месяцев.
   *
   * @param trx - активная транзакция
   * @param offset - смещение в месяцах от текущего (0 — текущий месяц)
   * @returns Имя созданной или уже существующей партиции
   * @throws {Error} Если функция `ensure_notifications_partition` не вернула имя партиции
   */
  private async ensurePartitionForMonthOffset(
    trx: Transaction<Database>,
    offset: number,
  ): Promise<string> {
    const result = await sql<{ partition_name: string }>`
      select ensure_notifications_partition(
        (current_date + make_interval(months => ${offset}))::date
      ) as partition_name
    `.execute(trx);
    const partitionName = result.rows[0]?.partition_name;
    if (partitionName === undefined) {
      throw new Error(
        `ensure_notifications_partition не вернула имя партиции (offset=${String(offset)})`,
      );
    }
    return partitionName;
  }

  /**
   * Предупреждает в логах, если в `notifications_default` появились строки.
   *
   * Зачем: попадание строк в default-партицию означает, что автосоздание партиций отстало
   * от реального потока данных — это сигнал для расследования, а не штатное поведение.
   *
   * @param trx - активная транзакция
   * @returns Promise, завершающийся после проверки
   */
  private async warnIfDefaultPartitionUsed(trx: Transaction<Database>): Promise<void> {
    const result = await sql<{ row_count: string }>`
      select count(*)::text as row_count from notifications_default
    `.execute(trx);
    const rowCount = Number(result.rows[0]?.row_count ?? '0');
    if (rowCount > 0) {
      this.logger.warn(
        `В notifications_default обнаружено ${String(rowCount)} строк — автосоздание партиций отстаёт от потока данных`,
      );
    }
  }
}
