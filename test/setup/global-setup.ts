import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';

import { applyMigrations, startPostgresContainer } from './testcontainers';

declare global {
  // Ambient-объявление глобальной переменной требует `var` — таково ограничение TypeScript
  // для расширения `globalThis`, `let`/`const` здесь недопустимы синтаксически.
  var __NOTIFICATIONS_PG_CONTAINER__: StartedPostgreSqlContainer | undefined;
}

/**
 * Глобальная подготовка окружения перед прогоном integration-тестов Jest.
 *
 * Зачем: контейнер PostgreSQL и миграции должны быть готовы один раз до запуска любого
 * тестового файла проекта `integration`, а не в каждом файле по отдельности.
 * Как: поднимает контейнер, публикует `DATABASE_URL` через `process.env` (Jest форкает
 * тестовые воркеры уже после `globalSetup`, поэтому переменная окружения наследуется),
 * применяет миграции и сохраняет ссылку на контейнер в `globalThis` для `globalTeardown`
 * (Jest выполняет `globalSetup`/`globalTeardown` в одном и том же главном процессе).
 *
 * @returns Promise, завершающийся после готовности БД
 */
export default async function globalSetup(): Promise<void> {
  // До создания Nest-приложений: без этого pino-pretty/cron оставляют open handles в Jest.
  process.env['NODE_ENV'] = 'test';
  process.env['CRON_ENABLED'] = 'false';
  // Sweeper включается точечно в offline-backlog e2e, иначе мешает другим сценариям.
  process.env['SWEEPER_ENABLED'] = 'false';

  const container = await startPostgresContainer();
  globalThis.__NOTIFICATIONS_PG_CONTAINER__ = container;

  const databaseUrl = container.getConnectionUri();
  process.env['DATABASE_URL'] = databaseUrl;

  await applyMigrations(databaseUrl);
}
