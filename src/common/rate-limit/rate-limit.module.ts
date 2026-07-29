import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule, type ThrottlerModuleOptions } from '@nestjs/throttler';

import { AppConfigService } from '../config/app-config.service.js';

import { HttpThrottlerGuard } from './http-throttler.guard.js';

/**
 * Модуль транспортного лимита частоты HTTP-запросов.
 *
 * Зачем: отделить защиту от флуда (на IP, до БД) от бизнес-лимита на (userId, type).
 * Как: ThrottlerModule с окном и лимитом из конфига; HttpThrottlerGuard как APP_GUARD.
 *
 * Важно: модуль импортируется в AppModule раньше AuthModule, чтобы guard срабатывал до разбора
 * JWT — иначе поток запросов с мусорными токенами тратил бы CPU на проверку подписи.
 * Ведро счётчика — (IP, маршрут), как в @nestjs/throttler по умолчанию: тяжёлый POST не делит
 * бюджет с дешёвым GET. Отключается флагом HTTP_RATE_LIMIT_ENABLED (тесты, локальные прогоны).
 */
@Module({
  imports: [
    ThrottlerModule.forRootAsync({
      inject: [AppConfigService],
      useFactory: (config: AppConfigService): ThrottlerModuleOptions => ({
        throttlers: [{ ttl: config.httpRateWindowMs, limit: config.httpRateLimit }],
        skipIf: () => !config.httpRateLimitEnabled,
      }),
    }),
  ],
  providers: [{ provide: APP_GUARD, useClass: HttpThrottlerGuard }],
})
export class RateLimitModule {}
