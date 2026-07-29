import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { sql, type Transaction } from 'kysely';

import { AppConfigService } from '../../common/config/app-config.service.js';
import { KyselyService } from '../kysely.service.js';
import type { Database } from '../schema.types.js';
import { withTransaction } from '../transaction.helper.js';

/**
 * Ключ advisory-лока retention (отдельный от обслуживания партиций — джобы не должны блокировать
 * друг друга).
 */
const RETENTION_LOCK_KEY = 'notifications:retention';

/**
 * Разрешённый формат имени месячной партиции: `notifications_YYYY_MM`.
 *
 * Зачем: единственная защита от `DROP TABLE` по произвольному имени — удаляются только строки,
 * прошедшие через эту регулярку, независимо от того, что вернул запрос к `pg_tables`.
 */
const PARTITION_NAME_PATTERN = /^notifications_\d{4}_\d{2}$/;

/**
 * Удаляет устаревшие месячные партиции таблицы `notifications`.
 *
 * Зачем: при 500k уведомлений/сутки (~250 МБ/сутки, см. ADR-0005) хранить данные вечно
 * нельзя — но `DELETE` по миллионам строк создаёт VACUUM-долг и долго держит блокировки.
 * `DROP TABLE` партиции — операция O(1) на уровне каталога, без сканирования данных.
 * Как: раз в сутки под advisory-локом транзакции находит партиции старше `RETENTION_MONTHS`
 * (сравнение имён `notifications_YYYY_MM`, т.к. они лексикографически сортируются как даты)
 * и удаляет их, если имя прошло строгую проверку по regexp. По умолчанию выключено
 * (`RETENTION_ENABLED=false`) — удаление данных должно быть осознанным решением оператора,
 * а не побочным эффектом деплоя (см. ADR-0005).
 */
@Injectable()
export class RetentionService implements OnApplicationBootstrap {
  private readonly logger = new Logger(RetentionService.name);

  /**
   * Создаёт сервис retention.
   *
   * @param kyselyService - типизированный доступ к БД
   * @param config - конфигурация приложения (RETENTION_ENABLED, RETENTION_MONTHS)
   */
  public constructor(
    private readonly kyselyService: KyselyService,
    private readonly config: AppConfigService,
  ) {}

  /**
   * Логирует текущий режим retention при старте приложения.
   *
   * Зачем: оператор должен явно видеть в логах, что удаление старых данных выключено —
   * это осознанное решение по умолчанию, а не забытая настройка.
   *
   * @returns void
   */
  public onApplicationBootstrap(): void {
    if (this.config.retentionEnabled) {
      this.logger.log(
        `Retention включён: партиции старше ${String(this.config.retentionMonths)} мес. будут удаляться`,
      );
    } else {
      this.logger.log(
        'Retention выключен (RETENTION_ENABLED=false) — старые партиции не удаляются',
      );
    }
  }

  /**
   * Ежедневно удаляет партиции старше `RETENTION_MONTHS`, если retention включён.
   *
   * Зачем: хранилище не должно расти бесконечно без ручных операций оператора.
   * Как: при выключенном retention — no-op; иначе под advisory-локом транзакции находит
   * в `pg_tables` партиции с именем строго вида `notifications_YYYY_MM`, чьё имя лексикографически
   * меньше имени партиции месяца отсечения, и удаляет их через `DROP TABLE IF EXISTS`.
   * `notifications_default` под этот шаблон не подходит и никогда не удаляется этой джобой.
   *
   * @returns Promise, завершающийся после обработки retention текущим инстансом
   */
  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  public async enforceRetention(): Promise<void> {
    if (!this.config.retentionEnabled) {
      return;
    }

    await withTransaction(this.kyselyService.db, async (trx) => {
      const lockAcquired = await this.tryAcquireLock(trx);
      if (!lockAcquired) {
        this.logger.debug('Retention уже выполняется другим инстансом, пропускаю');
        return;
      }

      const cutoffPartitionName = this.computeCutoffPartitionName();
      const currentPartitionName = this.computeCurrentPartitionName();
      const stalePartitions = await this.findPartitionsOlderThan(trx, cutoffPartitionName);

      for (const partitionName of stalePartitions) {
        // Страховка: никогда не трогаем текущий и будущие месяцы, даже если cutoff посчитан неверно.
        if (partitionName >= currentPartitionName) {
          this.logger.error(
            `Retention: пропуск ${partitionName} — имя не старше текущего месяца ${currentPartitionName}`,
          );
          continue;
        }
        await this.dropPartition(trx, partitionName);
      }
    });
  }

  /**
   * Пытается получить транзакционный advisory-лок retention.
   *
   * @param trx - активная транзакция
   * @returns true, если лок получен этим вызовом
   */
  private async tryAcquireLock(trx: Transaction<Database>): Promise<boolean> {
    const result = await sql<{ locked: boolean }>`
      select pg_try_advisory_xact_lock(hashtextextended(${RETENTION_LOCK_KEY}, 0)) as locked
    `.execute(trx);
    return result.rows[0]?.locked === true;
  }

  /**
   * Вычисляет имя партиции месяца отсечения (`notifications_YYYY_MM`).
   *
   * Зачем: партиции с более ранним (лексикографически меньшим) именем считаются устаревшими.
   * Как: считается в JS по UTC, без `make_interval` в SQL — так проще гарантировать, что
   * параметр месяцев не будет неверно интерпретирован драйвером.
   *
   * @returns Имя партиции, соответствующей началу окна хранения
   */
  private computeCutoffPartitionName(): string {
    return this.partitionNameMonthsAgo(this.config.retentionMonths);
  }

  /**
   * Имя партиции текущего месяца (UTC).
   *
   * @returns Имя вида `notifications_YYYY_MM`
   */
  private computeCurrentPartitionName(): string {
    return this.partitionNameMonthsAgo(0);
  }

  /**
   * Строит имя месячной партиции, отстоящей на `monthsAgo` месяцев назад от текущего UTC-месяца.
   *
   * @param monthsAgo - сколько месяцев вычесть (0 — текущий месяц)
   * @returns Имя вида `notifications_YYYY_MM`
   */
  private partitionNameMonthsAgo(monthsAgo: number): string {
    const date = new Date();
    date.setUTCDate(1);
    date.setUTCHours(0, 0, 0, 0);
    date.setUTCMonth(date.getUTCMonth() - monthsAgo);
    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, '0');
    return `notifications_${String(year)}_${month}`;
  }

  /**
   * Находит месячные партиции строго старше указанного порога.
   *
   * @param trx - активная транзакция
   * @param cutoffPartitionName - имя партиции месяца отсечения
   * @returns Список имён партиций, прошедших проверку по regexp
   */
  private async findPartitionsOlderThan(
    trx: Transaction<Database>,
    cutoffPartitionName: string,
  ): Promise<string[]> {
    const result = await sql<{ tablename: string }>`
      select tablename from pg_tables
      where schemaname = 'public'
        and tablename ~ '^notifications_[0-9]{4}_[0-9]{2}$'
        and tablename < ${cutoffPartitionName}
    `.execute(trx);
    return result.rows
      .map((row) => row.tablename)
      .filter((name) => PARTITION_NAME_PATTERN.test(name));
  }

  /**
   * Удаляет одну партицию по имени, предварительно ещё раз проверив его формат.
   *
   * Зачем: имя таблицы нельзя параметризовать в DDL, поэтому единственная защита от
   * подстановки непроверенного имени — строгая проверка формата перед конкатенацией.
   *
   * @param trx - активная транзакция
   * @param partitionName - имя партиции для удаления
   * @returns Promise, завершающийся после удаления партиции
   * @throws {Error} Если имя партиции не прошло проверку по regexp
   */
  private async dropPartition(trx: Transaction<Database>, partitionName: string): Promise<void> {
    if (!PARTITION_NAME_PATTERN.test(partitionName)) {
      throw new Error(`Отказ удалять партицию с недопустимым именем: ${partitionName}`);
    }
    this.logger.warn(`Retention: удаляю устаревшую партицию ${partitionName}`);
    await sql.raw(`drop table if exists "${partitionName}"`).execute(trx);
  }
}
