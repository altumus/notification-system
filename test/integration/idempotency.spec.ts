import { randomUUID } from 'node:crypto';

import { type INestApplication, ValidationPipe, VersioningType } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { sql } from 'kysely';
import request from 'supertest';

import { AppModule } from '@/app.module';
import { DomainExceptionFilter } from '@/common/errors/domain-exception.filter';
import { KyselyService } from '@/database/kysely.service';
import { IdempotencyService } from '@/notifications/idempotency/idempotency.service';

import { truncateAll } from '../setup/testcontainers';

describe('idempotency (integration)', () => {
  let app: INestApplication;
  let kysely: KyselyService;
  let idempotency: IdempotencyService;
  let serviceToken: string;

  /**
   * Выдаёт service-токен для create.
   *
   * @returns JWT
   */
  async function issueServiceToken(): Promise<string> {
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/dev-token')
      .send({ userId: randomUUID(), role: 'service' })
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
    idempotency = moduleRef.get(IdempotencyService);
    serviceToken = await issueServiceToken();
  });

  afterEach(async () => {
    await truncateAll(kysely.db);
  });

  afterAll(async () => {
    await app.close();
  });

  it('повтор с тем же ключом и телом → тот же ответ, одна строка в notifications', async () => {
    const userId = randomUUID();
    const key = `idem-${randomUUID()}`;
    const body = {
      userId,
      type: 'chat.message',
      payload: { text: 'hello' },
    };

    const first = await request(app.getHttpServer())
      .post('/api/v1/notifications')
      .set('Authorization', `Bearer ${serviceToken}`)
      .set('Idempotency-Key', key)
      .send(body)
      .expect(201);

    const second = await request(app.getHttpServer())
      .post('/api/v1/notifications')
      .set('Authorization', `Bearer ${serviceToken}`)
      .set('Idempotency-Key', key)
      .send(body)
      .expect(201);

    expect(second.headers['idempotent-replay']).toBe('true');
    expect(second.body.notification.id).toBe(first.body.notification.id);

    const count = await sql<{ n: string }>`
      select count(*)::text as n from notifications where user_id = ${userId}::uuid
    `.execute(kysely.db);
    expect(count.rows[0]?.n).toBe('1');
  });

  it('тот же ключ + другое тело → 409', async () => {
    const userId = randomUUID();
    const key = `idem-${randomUUID()}`;

    await request(app.getHttpServer())
      .post('/api/v1/notifications')
      .set('Authorization', `Bearer ${serviceToken}`)
      .set('Idempotency-Key', key)
      .send({ userId, type: 'chat.message', payload: { text: 'a' } })
      .expect(201);

    await request(app.getHttpServer())
      .post('/api/v1/notifications')
      .set('Authorization', `Bearer ${serviceToken}`)
      .set('Idempotency-Key', key)
      .send({ userId, type: 'chat.message', payload: { text: 'b' } })
      .expect(409);
  });

  it('после истечения TTL и очистки ключ переиспользуется', async () => {
    const userId = randomUUID();
    const key = `idem-${randomUUID()}`;
    const body = {
      userId,
      type: 'chat.message',
      payload: { text: 'ttl' },
    };

    await request(app.getHttpServer())
      .post('/api/v1/notifications')
      .set('Authorization', `Bearer ${serviceToken}`)
      .set('Idempotency-Key', key)
      .send(body)
      .expect(201);

    await sql`
      update idempotency_keys
      set expires_at = now() - interval '1 minute'
      where key = ${key}
    `.execute(kysely.db);

    await idempotency.purgeExpired();

    const keysLeft = await sql<{ n: string }>`
      select count(*)::text as n from idempotency_keys where key = ${key}
    `.execute(kysely.db);
    expect(keysLeft.rows[0]?.n).toBe('0');

    // Другое тело — иначе сработает бизнес-дедуп R6 (200), а не «свежий» create.
    const reusedBody = {
      userId,
      type: 'chat.message',
      payload: { text: 'ttl-reused' },
    };
    const reused = await request(app.getHttpServer())
      .post('/api/v1/notifications')
      .set('Authorization', `Bearer ${serviceToken}`)
      .set('Idempotency-Key', key)
      .send(reusedBody)
      .expect(201);

    expect(reused.headers['idempotent-replay']).toBeUndefined();
    expect(reused.body.status).toBe('created');

    const notifCount = await sql<{ n: string }>`
      select count(*)::text as n from notifications where user_id = ${userId}::uuid
    `.execute(kysely.db);
    expect(notifCount.rows[0]?.n).toBe('2');

    const keysAgain = await sql<{ n: string }>`
      select count(*)::text as n from idempotency_keys where key = ${key}
    `.execute(kysely.db);
    expect(keysAgain.rows[0]?.n).toBe('1');
  });

  it('параллельный повтор при pending → 409 и Retry-After', async () => {
    const userId = randomUUID();
    const key = `idem-${randomUUID()}`;
    const { key: normalized, requestHash } = idempotency.parseKeyAndHash(key, {
      userId,
      type: 'chat.message',
      payload: { text: 'pending' },
    });

    // Имитируем «запрос в полёте»: claim без complete.
    await idempotency.begin(normalized, userId, requestHash);

    const conflict = await request(app.getHttpServer())
      .post('/api/v1/notifications')
      .set('Authorization', `Bearer ${serviceToken}`)
      .set('Idempotency-Key', key)
      .send({ userId, type: 'chat.message', payload: { text: 'pending' } })
      .expect(409);

    expect(conflict.headers['retry-after']).toBe('1');
  });
});
