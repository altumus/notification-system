import { exec as execCallback } from 'node:child_process';
import { promisify } from 'node:util';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { sql, type Kysely } from 'kysely';

import type { Database } from '../../src/database/schema.types';

const execAsync = promisify(execCallback);

/**
 * Образ PostgreSQL для интеграционных тестов — совпадает с версией из docker-compose.yml.
 */
const POSTGRES_IMAGE = 'postgres:17-alpine';

/**
 * Поднимает одноразовый контейнер PostgreSQL для прогона интеграционных тестов.
 *
 * Зачем: интеграционные тесты работают с реальным Postgres (партиции, advisory-локи, jsonb,
 * `EXPLAIN`), а не с моками репозитория — иначе тест ничего не доказывает про поведение
 * реальной БД.
 * Как: один контейнер на весь прогон (`globalSetup`), не на каждый тестовый файл — иначе
 * старт контейнера доминировал бы над временем самих тестов.
 *
 * @returns Запущенный контейнер PostgreSQL
 */
export async function startPostgresContainer(): Promise<StartedPostgreSqlContainer> {
  return new PostgreSqlContainer(POSTGRES_IMAGE).start();
}

/**
 * Применяет миграции `node-pg-migrate` к указанной БД тем же способом, что docker-compose и CI.
 *
 * Зачем: миграции не должны дублироваться в двух местах (реальный `migrate:up` и отдельная
 * тестовая копия SQL) — иначе они неизбежно разойдутся.
 * Как: запускает существующий npm-скрипт `migrate:up` в дочернем процессе с переопределённым
 * `DATABASE_URL`, указывающим на контейнер.
 *
 * @param databaseUrl - строка подключения к тестовой БД
 * @returns Promise, завершающийся после применения всех миграций
 * @throws {Error} Если процесс миграции завершился с ненулевым кодом возврата
 */
export async function applyMigrations(databaseUrl: string): Promise<void> {
  await execAsync('pnpm run migrate:up', {
    env: { ...process.env, DATABASE_URL: databaseUrl },
  });
}

/**
 * Очищает пользовательские таблицы БД между тестами.
 *
 * Зачем: интеграционные тесты используют один контейнер на весь прогон — без очистки данные
 * одного теста мешают другому (например, rate-limit увидит чужие уведомления).
 * Как: `TRUNCATE ... RESTART IDENTITY CASCADE` по корневым (не-партиционным) таблицам
 * public-схемы, кроме служебной `pgmigrations`. `TRUNCATE` на партиционированной родительской
 * таблице автоматически очищает все её партиции — перечислять их отдельно не нужно. Список
 * таблиц читается из каталога `pg_class`, поэтому новые таблицы из будущих миграций
 * подхватываются автоматически, без правок этого файла.
 *
 * @param db - подключение Kysely к тестовой БД
 * @returns Promise, завершающийся после очистки
 */
export async function truncateAll(db: Kysely<Database>): Promise<void> {
  const tables = await sql<{ tablename: string }>`
    select c.relname as tablename
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind in ('r', 'p')
      and c.relispartition = false
      and c.relname <> 'pgmigrations'
  `.execute(db);

  if (tables.rows.length === 0) {
    return;
  }

  const tableList = tables.rows.map((row) => `"${row.tablename}"`).join(', ');
  await sql.raw(`truncate table ${tableList} restart identity cascade`).execute(db);
}
