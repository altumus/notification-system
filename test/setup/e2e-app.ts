import { join } from 'node:path';

import { type INestApplication, ValidationPipe, VersioningType } from '@nestjs/common';
import { type NestExpressApplication } from '@nestjs/platform-express';
import { Test, type TestingModule } from '@nestjs/testing';

import { AppModule } from '@/app.module';
import { DomainExceptionFilter } from '@/common/errors/domain-exception.filter';

/**
 * Опции сборки e2e-приложения.
 */
export interface CreateE2eAppOptions {
  /**
   * Если true — слушает случайный порт (нужно для Socket.IO).
   * Если false — только `app.init()` (достаточно для HTTP/supertest).
   */
  listen?: boolean;
}

/**
 * Результат сборки e2e-приложения.
 */
export interface E2eApp {
  app: INestApplication;
  moduleRef: TestingModule;
  /** Базовый HTTP URL (только при listen: true). */
  baseUrl: string | undefined;
}

/**
 * Собирает Nest-приложение для e2e с теми же пайпами/префиксом, что и production bootstrap.
 *
 * Зачем: единый teardown и меньше расхождений между e2e-файлами.
 * Как: ValidationPipe + DomainExceptionFilter + URI versioning + prefix `api` + `/demo` static.
 *
 * @param options - listen для WS-тестов
 * @returns Приложение и TestingModule
 */
export async function createE2eApp(options: CreateE2eAppOptions = {}): Promise<E2eApp> {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  const app = moduleRef.createNestApplication<NestExpressApplication>();
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.useGlobalFilters(new DomainExceptionFilter());
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  app.setGlobalPrefix('api', {
    exclude: ['health/live', 'health/ready', 'metrics', 'demo', 'demo/(.*)'],
  });
  app.useStaticAssets(join(process.cwd(), 'public', 'demo'), {
    prefix: '/demo/',
    index: 'index.html',
  });
  const http = app.getHttpAdapter();
  http.get('/demo', (_req: unknown, res: unknown) => {
    (res as { redirect: (path: string) => void }).redirect('/demo/');
  });
  // Нужно, чтобы OnApplicationShutdown (DeliveredBatchWriter) и закрытие пула отработали.
  app.enableShutdownHooks();

  let baseUrl: string | undefined;
  if (options.listen === true) {
    await app.listen(0);
    const address = app.getHttpServer().address();
    if (address === null || typeof address === 'string') {
      throw new Error('Не удалось получить порт тестового сервера');
    }
    baseUrl = `http://127.0.0.1:${String(address.port)}`;
  } else {
    await app.init();
  }

  return { app, moduleRef, baseUrl };
}

/**
 * Корректно останавливает e2e-приложение.
 *
 * Зачем: без полного close Jest висит на open handles (Socket.IO, pg Pool, cron, pino).
 * Как: `app.close()` → destroy модулей → pool.end / IO close.
 *
 * @param app - Nest-приложение
 * @returns void
 */
export async function closeE2eApp(app: INestApplication): Promise<void> {
  await app.close();
}
