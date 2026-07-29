import { randomUUID } from 'node:crypto';

import { Test, type TestingModule } from '@nestjs/testing';
import { sql } from 'kysely';

import { AppConfigService } from '@/common/config/app-config.service';
import { AppConfigModule } from '@/common/config/config.module';
import { DatabaseModule } from '@/database/database.module';
import { KyselyService } from '@/database/kysely.service';
import { PartitionMaintenanceService } from '@/database/maintenance/partition-maintenance.service';
import { RetentionService } from '@/database/maintenance/retention.service';

import { truncateAll } from '../setup/testcontainers';

/**
 * Читает переменные окружения заново, создавая независимый снимок конфигурации.
 *
 * Зачем: `RetentionService` в проде получает `AppConfigService` через DI (снимок конфигурации
 * фиксируется при старте приложения); в тесте нужно проверить поведение и при включённом,
 * и при выключенном retention без пересоздания всего Nest-модуля.
 *
 * @returns Новый экземпляр AppConfigService, читающий текущий process.env
 */
function freshConfig(): AppConfigService {
  return new AppConfigService();
}

async function tableExists(kyselyService: KyselyService, tableName: string): Promise<boolean> {
  const result = await sql<{ exists: boolean }>`
    select exists(select 1 from pg_tables where schemaname = 'public' and tablename = ${tableName}) as exists
  `.execute(kyselyService.db);
  return result.rows[0]?.exists === true;
}

describe('обслуживание партиций и retention (integration)', () => {
  let moduleRef: TestingModule;
  let kyselyService: KyselyService;
  let partitionMaintenanceService: PartitionMaintenanceService;
  const originalRetentionEnabled = process.env['RETENTION_ENABLED'];
  const originalRetentionMonths = process.env['RETENTION_MONTHS'];

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [AppConfigModule, DatabaseModule],
      providers: [PartitionMaintenanceService],
    }).compile();
    kyselyService = moduleRef.get(KyselyService);
    partitionMaintenanceService = moduleRef.get(PartitionMaintenanceService);
  });

  afterEach(async () => {
    await truncateAll(kyselyService.db);
    if (originalRetentionEnabled === undefined) {
      delete process.env['RETENTION_ENABLED'];
    } else {
      process.env['RETENTION_ENABLED'] = originalRetentionEnabled;
    }
    if (originalRetentionMonths === undefined) {
      delete process.env['RETENTION_MONTHS'];
    } else {
      process.env['RETENTION_MONTHS'] = originalRetentionMonths;
    }
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  it('повторный вызов создания партиций идемпотентен', async () => {
    await partitionMaintenanceService.ensurePartitions();
    await partitionMaintenanceService.ensurePartitions();

    const result = await sql<{ count: string }>`
      select count(*)::text as count from pg_tables
      where schemaname = 'public' and tablename = ${monthPartitionName(0)}
    `.execute(kyselyService.db);

    expect(result.rows[0]?.count).toBe('1');
  });

  it('удаляет устаревшую партицию при включённом retention, свежие данные не затрагивает', async () => {
    const ancientPartition = 'notifications_2000_01';
    // Строки в default с датами из этого диапазона (остатки других тестов) блокируют ATTACH партиции.
    await sql`
      delete from notifications_default
      where created_at >= timestamptz '2000-01-01'
        and created_at < timestamptz '2000-02-01'
    `.execute(kyselyService.db);
    await sql
      .raw(
        `
      drop table if exists ${ancientPartition}
    `,
      )
      .execute(kyselyService.db);
    await sql
      .raw(
        `
      create table ${ancientPartition}
      partition of notifications for values from ('2000-01-01') to ('2000-02-01')
    `,
      )
      .execute(kyselyService.db);

    const freshId = randomUUID();
    const freshCreatedAt = new Date();
    await sql`
      insert into notifications (id, user_id, type, payload, dedup_hash, created_at, last_seen_at)
      values (
        ${freshId}::uuid, ${randomUUID()}::uuid, 'order.status_changed', '{}'::jsonb,
        ${Buffer.from('test-hash')}, ${freshCreatedAt}, ${freshCreatedAt}
      )
    `.execute(kyselyService.db);

    process.env['RETENTION_ENABLED'] = 'true';
    process.env['RETENTION_MONTHS'] = '6';
    const retentionService = new RetentionService(kyselyService, freshConfig());

    await retentionService.enforceRetention();

    expect(await tableExists(kyselyService, ancientPartition)).toBe(false);

    const freshRow = await sql<{ id: string }>`
      select id from notifications where id = ${freshId}::uuid
    `.execute(kyselyService.db);
    expect(freshRow.rows).toHaveLength(1);
  });

  it('по умолчанию (RETENTION_ENABLED=false) не удаляет старые партиции', async () => {
    const ancientPartition = 'notifications_1999_01';
    await sql
      .raw(
        `
      create table if not exists ${ancientPartition}
      partition of notifications for values from ('1999-01-01') to ('1999-02-01')
    `,
      )
      .execute(kyselyService.db);

    delete process.env['RETENTION_ENABLED'];
    const retentionService = new RetentionService(kyselyService, freshConfig());

    await retentionService.enforceRetention();

    expect(await tableExists(kyselyService, ancientPartition)).toBe(true);

    await sql.raw(`drop table if exists ${ancientPartition}`).execute(kyselyService.db);
  });
});

/**
 * Возвращает имя месячной партиции, отстоящей от текущего месяца на заданное число месяцев.
 *
 * @param offsetMonths - смещение в месяцах (0 — текущий месяц)
 * @returns Имя партиции вида `notifications_YYYY_MM`
 */
function monthPartitionName(offsetMonths: number): string {
  const date = new Date();
  date.setUTCMonth(date.getUTCMonth() + offsetMonths);
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `notifications_${String(year)}_${month}`;
}
