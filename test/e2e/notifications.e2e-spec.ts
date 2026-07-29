import { randomUUID } from 'node:crypto';

import { type INestApplication, ValidationPipe, VersioningType } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import request from 'supertest';

import { AppModule } from '@/app.module';
import { DomainExceptionFilter } from '@/common/errors/domain-exception.filter';
import { KyselyService } from '@/database/kysely.service';

import { truncateAll } from '../setup/testcontainers';

describe('notifications e2e', () => {
  let app: INestApplication;
  let kysely: KyselyService;

  /**
   * Выдаёт Bearer-токен через /auth/dev-token.
   *
   * @param userId - субъект токена
   * @param role - роль
   * @returns JWT-строка
   */
  async function issueToken(userId: string, role: 'user' | 'service' = 'service'): Promise<string> {
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/dev-token')
      .send({ userId, role })
      .expect(201);
    return res.body.token as string;
  }

  beforeAll(async () => {
    process.env['AUTH_DEV_TOKENS_ENABLED'] = 'true';
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
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
    kysely = moduleRef.get(KyselyService);
  });

  afterEach(async () => {
    await truncateAll(kysely.db);
  });

  afterAll(async () => {
    await app.close();
  });

  it('POST create → 201; повтор с тем же orderId → 200 deduplicated', async () => {
    const userId = randomUUID();
    const token = await issueToken(userId, 'service');
    const body = {
      userId,
      type: 'order.status_changed',
      payload: { orderId: 1, status: 'new' },
    };
    const created = await request(app.getHttpServer())
      .post('/api/v1/notifications')
      .set('Authorization', `Bearer ${token}`)
      .send(body)
      .expect(201);
    expect(created.body.status).toBe('created');

    const dedup = await request(app.getHttpServer())
      .post('/api/v1/notifications')
      .set('Authorization', `Bearer ${token}`)
      .send({ ...body, payload: { status: 'shipped', orderId: 1 } })
      .expect(200);
    expect(dedup.body.status).toBe('deduplicated');
    expect(dedup.body.notification.occurrences).toBe(2);
  });

  it('400/422 на мусорном вводе', async () => {
    const token = await issueToken(randomUUID(), 'service');
    await request(app.getHttpServer())
      .post('/api/v1/notifications')
      .set('Authorization', `Bearer ${token}`)
      .send({ userId: 'not-uuid', type: 'BAD', payload: [], extra: true })
      .expect((res) => {
        expect([400, 422]).toContain(res.status);
      });
  });

  it('unread / mark read / 404 на чужом id', async () => {
    const userId = randomUUID();
    const serviceToken = await issueToken(randomUUID(), 'service');
    const userToken = await issueToken(userId, 'user');
    const strangerToken = await issueToken(randomUUID(), 'user');

    const created = await request(app.getHttpServer())
      .post('/api/v1/notifications')
      .set('Authorization', `Bearer ${serviceToken}`)
      .send({ userId, type: 'chat.message', payload: { text: 'a' } })
      .expect(201);

    const id = created.body.notification.id as string;

    const unread = await request(app.getHttpServer())
      .get('/api/v1/notifications/unread')
      .set('Authorization', `Bearer ${userToken}`)
      .expect(200);
    expect(unread.body.items).toHaveLength(1);

    await request(app.getHttpServer())
      .patch(`/api/v1/notifications/${id}/read`)
      .set('Authorization', `Bearer ${userToken}`)
      .expect(200);

    await request(app.getHttpServer())
      .patch(`/api/v1/notifications/${id}/read`)
      .set('Authorization', `Bearer ${strangerToken}`)
      .expect(404);
  });

  it('429 после 10 create с заголовками RateLimit', async () => {
    const userId = randomUUID();
    const token = await issueToken(userId, 'service');
    for (let i = 0; i < 10; i += 1) {
      await request(app.getHttpServer())
        .post('/api/v1/notifications')
        .set('Authorization', `Bearer ${token}`)
        .send({ userId, type: 'chat.message', payload: { i } })
        .expect(201);
    }
    const limited = await request(app.getHttpServer())
      .post('/api/v1/notifications')
      .set('Authorization', `Bearer ${token}`)
      .send({ userId, type: 'chat.message', payload: { i: 10 } })
      .expect(429);
    expect(limited.headers['retry-after']).toBeDefined();
  });
});
