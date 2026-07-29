import { randomUUID } from 'node:crypto';

import { Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import type { Options } from 'pino-http';

import { AppConfigService } from '../config/app-config.service.js';

import { requestContextStorage } from './request-context.js';

/**
 * Собирает опции pino-http из конфигурации.
 *
 * Зачем: избежать `transport: undefined` при exactOptionalPropertyTypes.
 * Как: в production transport не добавляется; в dev — pino-pretty.
 *
 * @param config - типизированный конфиг приложения
 * @returns Опции pino-http
 */
function buildPinoHttpOptions(config: AppConfigService): Options {
  const options: Options = {
    level: config.logLevel,
    genReqId: (req, res) => {
      const header = req.headers['x-request-id'];
      const fromHeader = Array.isArray(header) ? header[0] : header;
      const requestId =
        typeof fromHeader === 'string' && fromHeader.length > 0 ? fromHeader : randomUUID();
      res.setHeader('x-request-id', requestId);
      requestContextStorage.enterWith({ requestId });
      return requestId;
    },
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'req.body.token',
        'req.body.payload',
      ],
      remove: config.isProduction,
    },
    customProps: () => {
      const requestId = requestContextStorage.getStore()?.requestId;
      return requestId === undefined ? {} : { requestId };
    },
  };

  if (!config.isProduction) {
    options.transport = {
      target: 'pino-pretty',
      options: { singleLine: true, colorize: true },
    };
  }

  return options;
}

/**
 * Модуль структурного логирования на pino.
 *
 * Зачем: единый формат логов, редакция секретов в production, requestId на каждый HTTP-запрос.
 * Как: nestjs-pino + genReqId; middleware кладёт id в AsyncLocalStorage.
 */
@Module({
  imports: [
    LoggerModule.forRootAsync({
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) => ({
        pinoHttp: buildPinoHttpOptions(config),
      }),
    }),
  ],
})
export class AppLoggingModule {}
