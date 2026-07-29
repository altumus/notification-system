import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';

declare global {
  // Ambient-объявление глобальной переменной требует `var` — таково ограничение TypeScript
  // для расширения `globalThis`, `let`/`const` здесь недопустимы синтаксически.
  var __NOTIFICATIONS_PG_CONTAINER__: StartedPostgreSqlContainer | undefined;
}

/**
 * Глобальная остановка окружения после прогона integration-тестов Jest.
 *
 * Зачем: освобождает ресурсы Docker — без явной остановки контейнеры копятся между прогонами
 * локально и в CI.
 * Как: читает ссылку на контейнер, сохранённую `globalSetup` в `globalThis`, и останавливает его.
 *
 * @returns Promise, завершающийся после остановки контейнера
 */
export default async function globalTeardown(): Promise<void> {
  await globalThis.__NOTIFICATIONS_PG_CONTAINER__?.stop();
}
