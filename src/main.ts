import { ValidationPipe, VersioningType } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { Logger, PinoLogger } from 'nestjs-pino';

import { AppModule } from './app.module.js';
import { AppConfigService } from './common/config/app-config.service.js';
import { AllExceptionsFilter } from './common/errors/all-exceptions.filter.js';

/**
 * Точка входа HTTP-приложения.
 *
 * Зачем: единый bootstrap с security headers, CORS, валидацией, Swagger и graceful shutdown.
 * Как: создаёт Nest-приложение, настраивает пайпы/фильтры, слушает PORT из конфига.
 *
 * @returns Promise, завершающийся после старта сервера
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  const config = app.get(AppConfigService);
  const logger = app.get(Logger);

  app.useLogger(logger);
  app.use(helmet());
  app.enableCors({ origin: config.getCorsOriginOption() });
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
    exclude: ['health/live', 'health/ready', 'metrics'],
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
