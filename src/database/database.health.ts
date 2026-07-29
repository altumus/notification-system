import { Injectable } from '@nestjs/common';
import { type HealthIndicatorResult, HealthIndicatorService } from '@nestjs/terminus';
import { sql } from 'kysely';

import { KyselyService } from './kysely.service.js';

/**
 * Жёсткий таймаут проверки БД для /health/ready (мс).
 *
 * Зачем: readiness обязан отвечать быстро даже если БД зависла — иначе балансировщик сам
 * упрётся в таймаут запроса вместо чёткого 503.
 */
const READY_CHECK_TIMEOUT_MS = 2_000;

/**
 * Health-индикатор доступности PostgreSQL для эндпоинта `/health/ready`.
 *
 * Зачем: readiness обязан реально проверять зависимость (R2), а не только то, что процесс жив —
 * иначе балансировщик будет слать трафик на инстанс без доступа к БД.
 * Как: выполняет лёгкий `select 1` через общий пул с жёстким таймаутом; используется через
 * `HealthIndicatorService` — это актуальный (не deprecated) API `@nestjs/terminus` 11.
 */
@Injectable()
export class DatabaseHealthIndicator {
  /**
   * Создаёт индикатор.
   *
   * @param kyselyService - типизированный доступ к БД, используемый для проверочного запроса
   * @param healthIndicatorService - фабрика результатов индикаторов из Terminus
   */
  public constructor(
    private readonly kyselyService: KyselyService,
    private readonly healthIndicatorService: HealthIndicatorService,
  ) {}

  /**
   * Проверяет доступность БД одним лёгким запросом.
   *
   * Зачем: используется в `HealthController.ready()` как часть `HealthCheckService.check()`.
   * Как: `select 1` с ограничением по времени; таймаут или любая ошибка соединения превращаются
   * в статус `down` без падения запроса — сам факт недоступности БД это ожидаемый исход readiness,
   * а не 500-я ошибка сервера.
   *
   * @returns Результат индикатора для `HealthCheckService.check()`
   */
  public async isHealthy(): Promise<HealthIndicatorResult> {
    const indicator = this.healthIndicatorService.check('database');
    try {
      await this.pingWithTimeout();
      return indicator.up();
    } catch (error) {
      return indicator.down({
        message: error instanceof Error ? error.message : 'Неизвестная ошибка подключения к БД',
      });
    }
  }

  /**
   * Выполняет `select 1` с ограничением по времени выполнения.
   *
   * @returns Promise, завершающийся при успешном ответе БД
   * @throws {Error} Если запрос не уложился в READY_CHECK_TIMEOUT_MS или соединение отказало
   */
  private async pingWithTimeout(): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`Проверка БД не уложилась в ${String(READY_CHECK_TIMEOUT_MS)} мс`));
      }, READY_CHECK_TIMEOUT_MS);
    });

    try {
      await Promise.race([sql`select 1`.execute(this.kyselyService.db), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }
}
