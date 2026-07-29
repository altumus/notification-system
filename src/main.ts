import { join } from 'node:path';

import { ValidationPipe, VersioningType } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { type NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { Logger, PinoLogger } from 'nestjs-pino';

import { AppModule } from './app.module.js';
import { AppConfigService } from './common/config/app-config.service.js';
import { AllExceptionsFilter } from './common/errors/all-exceptions.filter.js';

/**
 * Точка входа HTTP-приложения.
 *
 * Зачем: единый bootstrap с security headers, CORS, валидацией, Swagger, демо и graceful shutdown.
 * Как: создаёт Nest-приложение, настраивает пайпы/фильтры/статику `/demo`, слушает PORT.
 *
 * @returns Promise, завершающийся после старта сервера
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true });
  const config = app.get(AppConfigService);
  const logger = app.get(Logger);

  app.useLogger(logger);
  // Railway / любой reverse-proxy: корректные proto/IP за edge.
  app.set('trust proxy', 1);
  // CSP: демо грузит Socket.IO с CDN и локальный ESM-фолбэк; connect к своему origin/ws.
  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          'default-src': ["'self'"],
          'script-src': ["'self'", 'https://cdn.socket.io'],
          'style-src': ["'self'"],
          'connect-src': ["'self'", 'https://cdn.socket.io', 'ws:', 'wss:'],
          'img-src': ["'self'", 'data:'],
          'font-src': ["'self'"],
          'object-src': ["'none'"],
          'base-uri': ["'self'"],
          'frame-ancestors': ["'none'"],
        },
      },
    }),
  );
  app.enableCors({ origin: config.getCorsOriginOption() });
  // Тела запросов заведомо мелкие (payload ограничен 8 КБ в DTO) — не даём слать мегабайты.
  app.useBodyParser('json', { limit: '64kb' });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );
  app.useGlobalFilters(new AllExceptionsFilter(await app.resolve(PinoLogger)));
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  app.setGlobalPrefix('api', {
    exclude: ['health/live', 'health/ready', 'demo', 'demo/(.*)'],
  });
  // public/demo → GET /demo/ (и файлы app.js/styles.css/vendor/*).
  app.useStaticAssets(join(process.cwd(), 'public', 'demo'), {
    prefix: '/demo/',
    index: 'index.html',
  });
  // Удобный URL без trailing slash.
  const http = app.getHttpAdapter();
  http.get('/demo', (_req: unknown, res: unknown) => {
    (res as { redirect: (path: string) => void }).redirect('/demo/');
  });
  app.enableShutdownHooks();

  const swaggerConfig = new DocumentBuilder()
    .setTitle('Notification System API')
    .setDescription('REST API системы уведомлений')
    .setVersion('1.0')
    .addBearerAuth()
    .addTag('health')
    .addTag('notifications')
    .addTag('auth')
    .build();
  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('api/docs', app, document);

  await app.listen(config.port);
  logger.log(`HTTP слушает порт ${String(config.port)}`);
  logger.log(`Демо-страница: http://localhost:${String(config.port)}/demo/`);
  for (const warning of config.getProductionWarnings()) {
    logger.warn(warning);
  }

  const shutdown = async (signal: string): Promise<void> => {
    logger.log(`Получен ${signal}, начинаю graceful shutdown`);
    await app.close();
    process.exit(0);
  };

  process.once('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
  process.once('SIGINT', () => {
    void shutdown('SIGINT');
  });
}

void bootstrap();
