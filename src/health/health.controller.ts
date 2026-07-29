import { Controller, Get, VERSION_NEUTRAL } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { HealthCheck, HealthCheckService } from '@nestjs/terminus';

import { getAppVersion } from '../version.js';

/**
 * Эндпоинты liveness и readiness.
 *
 * Зачем: оркестраторы и docker HEALTHCHECK отличают «процесс жив» от «готов принимать трафик».
 * Как: /live всегда 200; /ready позже получит проверку БД (коммит 03). VERSION_NEUTRAL —
 * пути без /v1, как требует контракт /health/live.
 */
@ApiTags('health')
@Controller({ path: 'health', version: VERSION_NEUTRAL })
export class HealthController {
  /**
   * Создаёт контроллер health-проверок.
   *
   * @param health - сервис Nest Terminus
   */
  public constructor(private readonly health: HealthCheckService) {}

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
   * Зачем: балансировщик не шлёт трафик, пока зависимости не готовы.
   * Как: пока без индикаторов; БД-проверка добавится в коммите 03.
   *
   * @returns Результат HealthCheckService
   */
  @Get('ready')
  @HealthCheck()
  @ApiOperation({ summary: 'Readiness probe' })
  public ready(): ReturnType<HealthCheckService['check']> {
    return this.health.check([]);
  }
}
