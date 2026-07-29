import { Inject, Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { Kysely, PostgresDialect } from 'kysely';
import type { Pool } from 'pg';

import { PG_POOL } from './pool.provider.js';
import type { Database } from './schema.types.js';

/**
 * Типизированный доступ к PostgreSQL через Kysely поверх общего пула соединений.
 *
 * Зачем: даёт типы на запросы (см. `schema.types.ts`), но не отбирает возможность писать
 * произвольный SQL через `sql`-тег — что необходимо для advisory-локов, партиционирования
 * и `EXPLAIN` (см. ADR-0001: почему Kysely, а не полноценная ORM).
 * Как: оборачивает уже сконфигурированный `pg.Pool` в `PostgresDialect`, не создавая второй пул.
 */
@Injectable()
export class KyselyService implements OnApplicationShutdown {
  /**
   * Экземпляр Kysely для построения типизированных запросов.
   */
  public readonly db: Kysely<Database>;

  /**
   * Создаёт сервис, оборачивая инжектированный пул в Kysely.
   *
   * @param pool - общий пул соединений PostgreSQL (токен PG_POOL)
   */
  public constructor(@Inject(PG_POOL) pool: Pool) {
    this.db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
  }

  /**
   * Закрывает Kysely и обслуживаемый им пул в последней фазе остановки приложения.
   *
   * Зачем: Nest должен дождаться закрытия всех соединений перед завершением процесса
   * (graceful shutdown), иначе возможны предупреждения об открытых хендлах или потерянные запросы.
   * Почему именно `onApplicationShutdown`, а не `onModuleDestroy`: порядок фаз в Nest —
   * onModuleDestroy → beforeApplicationShutdown → onApplicationShutdown. Пул — инфраструктура,
   * он обязан переживать все фазы, где сервисы ещё дописывают состояние в БД (например
   * DeliveredBatchWriter сбрасывает буфер delivered_at в onModuleDestroy). Закрытие пула на
   * onModuleDestroy делало такие записи гонкой с «driver has already been destroyed».
   * Как: `Kysely.destroy()` вызывает `pool.end()` для переданного пула — второй вызов `pool.end()`
   * не нужен.
   *
   * @returns Promise, завершающийся после закрытия пула
   */
  public async onApplicationShutdown(): Promise<void> {
    await this.db.destroy();
  }
}
