import { Controller, Get, VERSION_NEUTRAL } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { HealthCheck, HealthCheckService } from '@nestjs/terminus';

import { Public } from '../auth/decorators/public.decorator.js';
import { DatabaseHealthIndicator } from '../database/database.health.js';
import { getAppVersion } from '../version.js';

/**
 * Эндпоинты liveness и readiness.
 *
 * Зачем: оркестраторы и docker HEALTHCHECK отличают «процесс жив» от «готов принимать трафик».
 * Как: /live всегда 200 и не трогает БД; /ready проверяет доступность PostgreSQL через
 * DatabaseHealthIndicator. VERSION_NEUTRAL — пути без /v1, как требует контракт /health/live.
 */
@Public()
@ApiTags('health')
@Controller({ path: 'health', version: VERSION_NEUTRAL })
export class HealthController {
  /**
   * Создаёт контроллер health-проверок.
   *
   * @param health - сервис Nest Terminus
   * @param databaseHealthIndicator - индикатор доступности PostgreSQL
   */
  public constructor(
    private readonly health: HealthCheckService,
    private readonly databaseHealthIndicator: DatabaseHealthIndicator,
  ) {}

  /**
   * Liveness: процесс жив и отвечает.
   *
   * Зачем: docker/k8s не должны рестартить контейнер только из-за временной недоступности БД.
   * Как: возвращает 200 с версией без внешних зависимостей.
   *
   * @returns Статус ok и версия приложения
   */
  @Get('live')
  @ApiOperation({ summary: 'Liveness probe' })
  public live(): { status: 'ok'; version: string } {
    return { status: 'ok', version: getAppVersion() };
  }

  /**
   * Readiness: готовность принимать трафик.
   *
   * Зачем: балансировщик не должен слать трафик на инстанс без доступа к БД.
   * Как: проверяет PostgreSQL через DatabaseHealthIndicator; 503 при недоступности.
   *
   * @returns Результат HealthCheckService
   */
  @Get('ready')
  @HealthCheck()
  @ApiOperation({ summary: 'Readiness probe' })
  public ready(): ReturnType<HealthCheckService['check']> {
    return this.health.check([() => this.databaseHealthIndicator.isHealthy()]);
  }
}
