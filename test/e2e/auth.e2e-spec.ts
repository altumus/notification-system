import { randomUUID } from 'node:crypto';

import { type INestApplication, ValidationPipe, VersioningType } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test, type TestingModule } from '@nestjs/testing';
import request from 'supertest';

import { AppModule } from '@/app.module';
import { AppConfigService } from '@/common/config/app-config.service';
import { DomainExceptionFilter } from '@/common/errors/domain-exception.filter';
import { KyselyService } from '@/database/kysely.service';

import { truncateAll } from '../setup/testcontainers';

/**
 * Собирает Nest-приложение для e2e auth с текущим process.env.
 *
 * @returns Приложение, Kysely и TestingModule
 */
async function createApp(): Promise<{
  app: INestApplication;
  kysely: KyselyService;
  moduleRef: TestingModule;
}> {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  const app = moduleRef.createNestApplication();
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
    exclude: ['health/live', 'health/ready', 'metrics'],
  });
  await app.init();
  return { app, kysely: moduleRef.get(KyselyService), moduleRef };
}

describe('auth e2e', () => {
  let app: INestApplication;
  let kysely: KyselyService;
  let moduleRef: TestingModule;

  beforeAll(async () => {
    process.env['AUTH_DEV_TOKENS_ENABLED'] = 'true';
    ({ app, kysely, moduleRef } = await createApp());
  });

  afterEach(async () => {
    await truncateAll(kysely.db);
  });

  afterAll(async () => {
    await app.close();
  });

  it('без токена → 401', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/notifications/unread').expect(401);
    expect(res.headers['content-type']).toMatch(/json/);
  });

  it('чужой userId под ролью user → 403', async () => {
    const tokenUserId = randomUUID();
    const otherUserId = randomUUID();
    const tokenRes = await request(app.getHttpServer())
      .post('/api/v1/auth/dev-token')
      .send({ userId: tokenUserId, role: 'user' })
      .expect(201);

    await request(app.getHttpServer())
      .post('/api/v1/notifications')
      .set('Authorization', `Bearer ${tokenRes.body.token as string}`)
      .send({
        userId: otherUserId,
        type: 'chat.message',
        payload: { text: 'nope' },
      })
      .expect(403);
  });

  it('роль service может создавать любому userId', async () => {
    const targetUserId = randomUUID();
    const tokenRes = await request(app.getHttpServer())
      .post('/api/v1/auth/dev-token')
      .send({ userId: randomUUID(), role: 'service' })
      .expect(201);

    await request(app.getHttpServer())
      .post('/api/v1/notifications')
      .set('Authorization', `Bearer ${tokenRes.body.token as string}`)
      .send({
        userId: targetUserId,
        type: 'chat.message',
        payload: { text: 'ok' },
      })
      .expect(201);
  });

  it('истёкший токен → 401 с problem+json', async () => {
    const config = moduleRef.get(AppConfigService);
    const jwt = moduleRef.get(JwtService);
    const token = await jwt.signAsync(
      { sub: randomUUID(), role: 'user' },
      { secret: config.jwtSecret, expiresIn: 0 },
    );

    const res = await request(app.getHttpServer())
      .get('/api/v1/notifications/unread')
      .set('Authorization', `Bearer ${token}`)
      .expect(401);

    expect(res.headers['content-type']).toMatch(/problem\+json|json/);
    expect(res.body).toEqual(
      expect.objectContaining({
        status: 401,
        title: expect.any(String) as string,
      }),
    );
  });

  it('health остаётся публичным без токена', async () => {
    await request(app.getHttpServer()).get('/health/live').expect(200);
  });
});

describe('auth e2e (dev-token disabled)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    process.env['AUTH_DEV_TOKENS_ENABLED'] = 'false';
    ({ app } = await createApp());
  });

  afterAll(async () => {
    await app.close();
    process.env['AUTH_DEV_TOKENS_ENABLED'] = 'true';
  });

  it('при AUTH_DEV_TOKENS_ENABLED=false маршрут dev-token → 404', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/auth/dev-token')
      .send({ userId: randomUUID(), role: 'user' })
      .expect(404);
  });
});
