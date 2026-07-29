import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';

import { HealthController } from './health.controller.js';

/**
 * Модуль health-проверок.
 *
 * Зачем: изолирует liveness/readiness от бизнес-модулей.
 * Как: подключает Terminus и HealthController.
 */
@Module({
  imports: [TerminusModule],
  controllers: [HealthController],
})
export class HealthModule {}
