import { randomUUID } from 'node:crypto';

import { type INestApplication } from '@nestjs/common';
import { type TestingModule } from '@nestjs/testing';
import request from 'supertest';

import { DEV_TOKEN_RATE_LIMIT } from '@/auth/auth.controller';
import { KyselyService } from '@/database/kysely.service';

import { closeE2eApp, createE2eApp } from '../setup/e2e-app';
import { truncateAll } from '../setup/testcontainers';

/**
 * Лимит, с которым поднимается приложение в этом файле.
 *
 * Мал намеренно: проверяем механизм, а не production-число (HTTP_RATE_LIMIT=300).
 */
const LIMIT = 5;

/**
 * Ведро счётчика — (IP, маршрут), и оно живёт весь HTTP_RATE_WINDOW_MS, то есть не сбрасывается
 * между тестами. Поэтому каждый тест исчерпывает свой маршрут, а не общий.
 */
describe('http rate limit e2e', () => {
  let app: INestApplication;
  let moduleRef: TestingModule;
  let kysely: KyselyService;
  let token: string;

  beforeAll(async () => {
    process.env['HTTP_RATE_LIMIT_ENABLED'] = 'true';
    process.env['HTTP_RATE_LIMIT'] = String(LIMIT);
    process.env['HTTP_RATE_WINDOW_MS'] = '60000';
    process.env['AUTH_DEV_TOKENS_ENABLED'] = 'true';

    const created = await createE2eApp();
    app = created.app;
    moduleRef = created.moduleRef;
    kysely = moduleRef.get(KyselyService);

    const tokenRes = await request(app.getHttpServer())
      .post('/api/v1/auth/dev-token')
      .send({ userId: randomUUID(), role: 'service' })
      .expect(201);
    token = tokenRes.body.token as string;
  });

  afterEach(async () => {
    await truncateAll(kysely.db);
  });

  afterAll(async () => {
    await closeE2eApp(app);
    process.env['HTTP_RATE_LIMIT_ENABLED'] = 'false';
    delete process.env['HTTP_RATE_LIMIT'];
    delete process.env['HTTP_RATE_WINDOW_MS'];
  });

  it('после HTTP_RATE_LIMIT запросов отдаёт 429 problem+json, отличимый от бизнес-лимита', async () => {
    const responses: request.Response[] = [];
    // LIMIT + 1 запросов: последний обязан упереться в лимит.
    for (let index = 0; index <= LIMIT; index += 1) {
      responses.push(
        await request(app.getHttpServer())
          .get('/api/v1/notifications/unread')
          .set('Authorization', `Bearer ${token}`),
      );
    }

    expect(responses.slice(0, LIMIT).map((res) => res.status)).toEqual(
      Array.from({ length: LIMIT }, () => 200),
    );

    const blocked = responses[LIMIT];
    expect(blocked?.status).toBe(429);
    expect(blocked?.headers['content-type']).toMatch(/problem\+json/);
    // Отдельный type: бизнес-лимит на (userId, type) отдаёт `rate-limit-exceeded`.
    expect(blocked?.body).toEqual(
      expect.objectContaining({
        type: 'https://example.com/problems/too-many-requests',
        status: 429,
        limit: LIMIT,
      }),
    );
    // Клиент должен понять, когда повторять, иначе будет долбиться в закрытую дверь.
    expect(Number(blocked?.headers['retry-after'])).toBeGreaterThan(0);
    expect(blocked?.headers['ratelimit-limit']).toBe(String(LIMIT));
    expect(blocked?.headers['ratelimit-remaining']).toBe('0');
  });

  it('ведро считается на маршрут: исчерпанный GET не блокирует создание уведомления', async () => {
    for (let index = 0; index <= LIMIT; index += 1) {
      await request(app.getHttpServer())
        .get('/api/v1/notifications/unread/count')
        .set('Authorization', `Bearer ${token}`);
    }

    await request(app.getHttpServer())
      .get('/api/v1/notifications/unread/count')
      .set('Authorization', `Bearer ${token}`)
      .expect(429);

    await request(app.getHttpServer())
      .post('/api/v1/notifications')
      .set('Authorization', `Bearer ${token}`)
      .send({ userId: randomUUID(), type: 'chat.message', payload: { text: 'ok' } })
      .expect(201);
  });

  it('health исключён из лимита: пробы оркестратора не должны его исчерпывать', async () => {
    for (let index = 0; index < LIMIT * 3; index += 1) {
      await request(app.getHttpServer()).get('/health/live').expect(200);
    }
  });

  it('анонимный /auth/dev-token ограничен своим лимитом до подписи JWT', async () => {
    // Маршрут @Public: лимит обязан срабатывать без аутентификации, иначе анонимный флуд бесплатен.
    // Свой @Throttle строже общего, поэтому LIMIT здесь не применяется.
    let last: request.Response | undefined;
    for (let index = 0; index <= DEV_TOKEN_RATE_LIMIT; index += 1) {
      last = await request(app.getHttpServer())
        .post('/api/v1/auth/dev-token')
        .send({ userId: randomUUID(), role: 'user' });
    }

    expect(last?.status).toBe(429);
  });
});
