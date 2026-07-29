import { HealthIndicatorService } from '@nestjs/terminus';
import { Test, type TestingModule } from '@nestjs/testing';
import { sql } from 'kysely';
import { Pool } from 'pg';

import { AppConfigModule } from '@/common/config/config.module';
import { DatabaseHealthIndicator } from '@/database/database.health';
import { DatabaseModule } from '@/database/database.module';
import { KyselyService } from '@/database/kysely.service';
import { withTransaction } from '@/database/transaction.helper';

describe('database (integration)', () => {
  let moduleRef: TestingModule;
  let kyselyService: KyselyService;
  let databaseHealthIndicator: DatabaseHealthIndicator;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [AppConfigModule, DatabaseModule],
    }).compile();

    kyselyService = moduleRef.get(KyselyService);
    databaseHealthIndicator = moduleRef.get(DatabaseHealthIndicator);
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  it('выполняет запрос через реальный пул PostgreSQL', async () => {
    const result = await sql<{ value: number }>`select 1 as value`.execute(kyselyService.db);
    expect(result.rows[0]?.value).toBe(1);
  });

  it('DatabaseHealthIndicator.isHealthy() возвращает up при доступной БД', async () => {
    const result = await databaseHealthIndicator.isHealthy();
    expect(result['database']?.status).toBe('up');
  });

  it('DatabaseHealthIndicator.isHealthy() возвращает down при недоступной БД', async () => {
    const unreachablePool = new Pool({
      connectionString: 'postgresql://user:pass@127.0.0.1:1/nonexistent',
      connectionTimeoutMillis: 1_000,
    });
    const unreachableKysely = new KyselyService(unreachablePool);
    const indicator = new DatabaseHealthIndicator(unreachableKysely, new HealthIndicatorService());

    const result = await indicator.isHealthy();
    expect(result['database']?.status).toBe('down');

    await unreachableKysely.onApplicationShutdown();
  });

  describe('withTransaction', () => {
    it('коммитит результат с первой попытки, если ошибок нет', async () => {
      const result = await withTransaction(kyselyService.db, async (trx) => {
        const row = await sql<{ value: number }>`select 2 as value`.execute(trx);
        return row.rows[0]?.value;
      });
      expect(result).toBe(2);
    });

    it('повторяет транзакцию при ретраибельной ошибке (40001) и в итоге завершается успешно', async () => {
      let attempts = 0;
      const result = await withTransaction(kyselyService.db, async (trx) => {
        attempts += 1;
        await sql`select 1`.execute(trx);
        if (attempts < 3) {
          throw Object.assign(new Error('serialization_failure'), { code: '40001' });
        }
        return 'ok';
      });

      expect(result).toBe('ok');
      expect(attempts).toBe(3);
    });

    it('повторяет транзакцию при дедлоке (40P01)', async () => {
      let attempts = 0;
      const result = await withTransaction(kyselyService.db, async (trx) => {
        attempts += 1;
        await sql`select 1`.execute(trx);
        if (attempts < 2) {
          throw Object.assign(new Error('deadlock_detected'), { code: '40P01' });
        }
        return 'ok';
      });

      expect(result).toBe('ok');
      expect(attempts).toBe(2);
    });

    it('не повторяет при неретраибельной ошибке', async () => {
      let attempts = 0;

      await expect(
        withTransaction(kyselyService.db, async (trx) => {
          attempts += 1;
          await sql`select 1`.execute(trx);
          throw Object.assign(new Error('unique_violation'), { code: '23505' });
        }),
      ).rejects.toThrow('unique_violation');

      expect(attempts).toBe(1);
    });

    it('выбрасывает исходную ошибку после исчерпания попыток (максимум 3)', async () => {
      let attempts = 0;

      await expect(
        withTransaction(kyselyService.db, async (trx) => {
          attempts += 1;
          await sql`select 1`.execute(trx);
          throw Object.assign(new Error('always_conflicts'), { code: '40001' });
        }),
      ).rejects.toThrow('always_conflicts');

      expect(attempts).toBe(3);
    });
  });
});
