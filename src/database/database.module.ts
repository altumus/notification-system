import { Global, Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';

import { AppConfigService } from '../common/config/app-config.service.js';

import { DatabaseHealthIndicator } from './database.health.js';
import { KyselyService } from './kysely.service.js';
import { createPgPool, PG_POOL } from './pool.provider.js';

/**
 * Глобальный модуль доступа к PostgreSQL.
 *
 * Зачем: пул соединений и Kysely нужны почти всем будущим доменным модулям (notifications,
 * realtime, maintenance) — повторный импорт в каждом из них добавлял бы шум без пользы.
 * Как: заводит единственный `pg.Pool` через фабрику из `AppConfigService`, оборачивает его
 * в `KyselyService` и публикует `DatabaseHealthIndicator` для `/health/ready`. Помечен `@Global`
 * по аналогии с `AppConfigModule` — импортируется один раз в `AppModule`.
 */
@Global()
@Module({
  imports: [TerminusModule],
  providers: [
    {
      provide: PG_POOL,
      inject: [AppConfigService],
      useFactory: createPgPool,
    },
    KyselyService,
    DatabaseHealthIndicator,
  ],
  exports: [KyselyService, DatabaseHealthIndicator],
})
export class DatabaseModule {}
