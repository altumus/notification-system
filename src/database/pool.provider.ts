import { Logger } from '@nestjs/common';
import { Pool } from 'pg';

import type { AppConfigService } from '../common/config/app-config.service.js';

/**
 * DI-токен пула соединений PostgreSQL.
 *
 * Зачем: `pg.Pool` — не класс приложения, поэтому его нельзя внедрять по типу; символ даёт
 * уникальный и не конфликтующий с другими провайдерами токен.
 */
export const PG_POOL = Symbol('PG_POOL');

const logger = new Logger('PgPool');

/**
 * Создаёт пул соединений PostgreSQL из конфигурации приложения.
 *
 * Зачем: единая точка настройки пула — таймауты и лимиты не должны расползаться по коду,
 * иначе всплеск нагрузки съедает все доступные соединения Postgres.
 * Как: `max`/`statement_timeout` берутся из конфига; `connectionTimeoutMillis`/`idleTimeoutMillis`
 * — консервативные литералы (пока не нужны отдельные env-переменные — при необходимости их
 * несложно вынести). `idle_in_transaction_session_timeout` намеренно равен `statement_timeout`:
 * отдельной env-переменной под него нет, а единый бюджет времени проще объяснить ревьюеру, чем
 * два независимых числа без явной связи. Ошибки простаивающих соединений пула логируются,
 * а не приводят к падению процесса — обрыв одного физического соединения не должен убивать API.
 *
 * @param config - типизированная конфигурация приложения
 * @returns Пул `pg.Pool`, готовый к использованию в Kysely
 */
export function createPgPool(config: AppConfigService): Pool {
  const pool = new Pool({
    connectionString: config.databaseUrl,
    max: config.dbPoolMax,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    application_name: 'notification-system-api',
    statement_timeout: config.dbStatementTimeoutMs,
    idle_in_transaction_session_timeout: config.dbStatementTimeoutMs,
  });

  pool.on('error', (error: Error) => {
    logger.error(`Ошибка простаивающего соединения пула: ${error.message}`, error.stack);
  });

  return pool;
}
