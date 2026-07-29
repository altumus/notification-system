import { randomUUID } from 'node:crypto';

import { Test, type TestingModule } from '@nestjs/testing';
import { sql } from 'kysely';

import { AppConfigModule } from '@/common/config/config.module';
import { DatabaseModule } from '@/database/database.module';
import { KyselyService } from '@/database/kysely.service';

import { truncateAll } from '../setup/testcontainers';

/**
 * Узел плана `EXPLAIN (FORMAT JSON)` в объёме, нужном тестам (остальные поля не используются).
 */
interface ExplainPlanNode {
  'Node Type'?: string;
  'Relation Name'?: string;
  'Index Name'?: string;
  Plans?: ExplainPlanNode[];
}

/**
 * Разворачивает дерево плана запроса в плоский список узлов (включая корень).
 *
 * @param node - узел плана
 * @returns Список узлов: сам узел и все его потомки
 */
function flattenPlan(node: ExplainPlanNode): ExplainPlanNode[] {
  const children = node.Plans ?? [];
  return [node, ...children.flatMap((child) => flattenPlan(child))];
}

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

describe('схема notifications (integration)', () => {
  let moduleRef: TestingModule;
  let kyselyService: KyselyService;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [AppConfigModule, DatabaseModule],
    }).compile();
    kyselyService = moduleRef.get(KyselyService);
  });

  afterEach(async () => {
    await truncateAll(kyselyService.db);
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  /**
   * Резолвит физические имена партиционных индексов-потомков заданного партиционированного
   * индекса. PostgreSQL называет индекс каждой партиции по своим правилам (например,
   * `notifications_2026_07_user_id_created_at_id_idx`), а не именем родителя — поэтому
   * `EXPLAIN` нельзя сверять с буквальной строкой `notifications_unread_idx`, только со
   * списком его потомков из каталога.
   *
   * @param parentIndexName - имя партиционированного индекса на родительской таблице
   * @returns Множество физических имён индексов-потомков во всех партициях
   */
  async function resolvePartitionIndexChildren(parentIndexName: string): Promise<Set<string>> {
    const result = await sql<{ child_index_name: string }>`
      select c.relname as child_index_name
      from pg_inherits i
      join pg_class c on c.oid = i.inhrelid
      join pg_class p on p.oid = i.inhparent
      where p.relname = ${parentIndexName}
    `.execute(kyselyService.db);
    return new Set(result.rows.map((row) => row.child_index_name));
  }

  it('создаёт партиции на текущий, следующие два месяца и default-партицию', async () => {
    const result = await sql<{ tablename: string }>`
      select tablename from pg_tables
      where schemaname = 'public' and tablename like 'notifications%'
    `.execute(kyselyService.db);
    const tableNames = result.rows.map((row) => row.tablename);

    expect(tableNames).toContain(monthPartitionName(0));
    expect(tableNames).toContain(monthPartitionName(1));
    expect(tableNames).toContain(monthPartitionName(2));
    expect(tableNames).toContain('notifications_default');
  });

  it('вставка попадает в партицию текущего месяца', async () => {
    const id = randomUUID();
    const createdAt = new Date();

    await sql`
      insert into notifications (id, user_id, type, payload, dedup_hash, created_at, last_seen_at)
      values (
        ${id}::uuid, ${randomUUID()}::uuid, 'order.status_changed', '{}'::jsonb,
        ${Buffer.from('test-hash')}, ${createdAt}, ${createdAt}
      )
    `.execute(kyselyService.db);

    const result = await sql<{ partition: string }>`
      select tableoid::regclass::text as partition from notifications where id = ${id}::uuid
    `.execute(kyselyService.db);

    expect(result.rows[0]?.partition).toBe(monthPartitionName(0));
  });

  it('вставка с датой вне диапазона существующих партиций уходит в notifications_default', async () => {
    const id = randomUUID();
    const createdAt = new Date('2000-01-01T00:00:00.000Z');

    await sql`
      insert into notifications (id, user_id, type, payload, dedup_hash, created_at, last_seen_at)
      values (
        ${id}::uuid, ${randomUUID()}::uuid, 'order.status_changed', '{}'::jsonb,
        ${Buffer.from('test-hash')}, ${createdAt}, ${createdAt}
      )
    `.execute(kyselyService.db);

    const result = await sql<{ partition: string }>`
      select tableoid::regclass::text as partition from notifications where id = ${id}::uuid
    `.execute(kyselyService.db);

    expect(result.rows[0]?.partition).toBe('notifications_default');
  });

  it('EXPLAIN для списка непрочитанных использует индекс notifications_unread_idx', async () => {
    const userId = randomUUID();
    const createdAt = new Date();

    await sql`
      insert into notifications (id, user_id, type, payload, dedup_hash, created_at, last_seen_at)
      values (
        ${randomUUID()}::uuid, ${userId}::uuid, 'order.status_changed', '{}'::jsonb,
        ${Buffer.from('test-hash')}, ${createdAt}, ${createdAt}
      )
    `.execute(kyselyService.db);

    const unreadIndexChildren = await resolvePartitionIndexChildren('notifications_unread_idx');

    const planRows = await kyselyService.db.transaction().execute(async (trx) => {
      // Таблица в тесте крошечная — без явного запрета seqscan планировщик по стоимости
      // выбрал бы последовательное сканирование, и тест не доказывал бы использование индекса.
      await sql`set local enable_seqscan = off`.execute(trx);
      return sql<{ 'QUERY PLAN': [{ Plan: ExplainPlanNode }] }>`
        explain (format json)
        select * from notifications
        where user_id = ${userId}::uuid and read_at is null
        order by created_at desc, id desc
        limit 20
      `.execute(trx);
    });

    const root = planRows.rows[0]?.['QUERY PLAN']?.[0]?.Plan;
    expect(root).toBeDefined();
    const usedIndexNames = flattenPlan(root as ExplainPlanNode)
      .map((node) => node['Index Name'])
      .filter((name): name is string => name !== undefined);

    expect(usedIndexNames.some((name) => unreadIndexChildren.has(name))).toBe(true);
  });

  it('EXPLAIN для поиска по id+created_at сканирует ровно одну партицию (pruning)', async () => {
    const id = randomUUID();
    const createdAt = new Date();

    await sql`
      insert into notifications (id, user_id, type, payload, dedup_hash, created_at, last_seen_at)
      values (
        ${id}::uuid, ${randomUUID()}::uuid, 'order.status_changed', '{}'::jsonb,
        ${Buffer.from('test-hash')}, ${createdAt}, ${createdAt}
      )
    `.execute(kyselyService.db);

    const planRows = await sql<{ 'QUERY PLAN': [{ Plan: ExplainPlanNode }] }>`
      explain (format json)
      select * from notifications where id = ${id}::uuid and created_at = ${createdAt}
    `.execute(kyselyService.db);

    const root = planRows.rows[0]?.['QUERY PLAN']?.[0]?.Plan;
    expect(root).toBeDefined();
    const scannedPartitions = flattenPlan(root as ExplainPlanNode).filter(
      (node) => node['Relation Name'] !== undefined,
    );

    expect(scannedPartitions).toHaveLength(1);
    expect(scannedPartitions[0]?.['Relation Name']).toBe(monthPartitionName(0));
  });
});
