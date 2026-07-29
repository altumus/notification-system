import { randomUUID } from 'node:crypto';

import { EventEmitterModule } from '@nestjs/event-emitter';
import { Test, type TestingModule } from '@nestjs/testing';
import { sql } from 'kysely';

import { AppConfigModule } from '@/common/config/config.module';
import { DatabaseModule } from '@/database/database.module';
import { KyselyService } from '@/database/kysely.service';
import { RateLimitExceededError } from '@/notifications/domain/errors';
import { NotificationsModule } from '@/notifications/notifications.module';
import { NotificationsService } from '@/notifications/notifications.service';

import { truncateAll } from '../setup/testcontainers';

describe('notifications create (integration)', () => {
  let moduleRef: TestingModule;
  let service: NotificationsService;
  let kysely: KyselyService;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [AppConfigModule, DatabaseModule, EventEmitterModule.forRoot(), NotificationsModule],
    }).compile();
    service = moduleRef.get(NotificationsService);
    kysely = moduleRef.get(KyselyService);
  });

  afterEach(async () => {
    await truncateAll(kysely.db);
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  it('дубль в окне 5 минут → deduplicated, occurrences=2', async () => {
    const userId = randomUUID();
    const payload = { orderId: 1, status: 'new' };
    const first = await service.create({ userId, type: 'order.status_changed', payload });
    const second = await service.create({
      userId,
      type: 'order.status_changed',
      payload: { status: 'shipped', orderId: 1 },
    });

    expect(first.status).toBe('created');
    expect(second.status).toBe('deduplicated');
    expect(second.notification.id).toBe(first.notification.id);
    expect(second.notification.occurrences).toBe(2);

    const count = await sql<{ n: string }>`
      select count(*)::text as n from notifications where user_id = ${userId}::uuid
    `.execute(kysely.db);
    expect(count.rows[0]?.n).toBe('1');
  });

  it('дубль после окна → вторая строка', async () => {
    const userId = randomUUID();
    const payload = { orderId: 99 };
    const first = await service.create({ userId, type: 'order.status_changed', payload });

    await sql`
      update notifications
      set created_at = created_at - interval '10 minutes',
          last_seen_at = last_seen_at - interval '10 minutes'
      where id = ${first.notification.id}::uuid
    `.execute(kysely.db);

    const second = await service.create({ userId, type: 'order.status_changed', payload });
    expect(second.status).toBe('created');
    expect(second.notification.id).not.toBe(first.notification.id);
  });

  it('разный payload без dedupKeys → две строки; с dedupKeys — одна', async () => {
    const userId = randomUUID();
    await service.create({
      userId,
      type: 'chat.message',
      payload: { text: 'a' },
    });
    await service.create({
      userId,
      type: 'chat.message',
      payload: { text: 'b' },
    });
    const chatCount = await sql<{ n: string }>`
      select count(*)::text as n from notifications where user_id = ${userId}::uuid and type = 'chat.message'
    `.execute(kysely.db);
    expect(chatCount.rows[0]?.n).toBe('2');

    const orderUser = randomUUID();
    await service.create({
      userId: orderUser,
      type: 'order.status_changed',
      payload: { orderId: 7, status: 'a' },
    });
    await service.create({
      userId: orderUser,
      type: 'order.status_changed',
      payload: { orderId: 7, status: 'b' },
    });
    const orderCount = await sql<{ n: string }>`
      select count(*)::text as n from notifications where user_id = ${orderUser}::uuid
    `.execute(kysely.db);
    expect(orderCount.rows[0]?.n).toBe('1');
  });

  it('11-е уведомление в окне → RateLimitExceededError', async () => {
    const userId = randomUUID();
    for (let i = 0; i < 10; i += 1) {
      const result = await service.create({
        userId,
        type: 'chat.message',
        payload: { i },
      });
      expect(result.status).toBe('created');
    }
    const count = await sql<{ n: string }>`
      select count(*)::text as n from notifications
      where user_id = ${userId}::uuid and type = 'chat.message'
    `.execute(kysely.db);
    expect(count.rows[0]?.n).toBe('10');
    await expect(
      service.create({ userId, type: 'chat.message', payload: { i: 10 } }),
    ).rejects.toBeInstanceOf(RateLimitExceededError);
  });

  it('лимит независим для разных типов и пользователей', async () => {
    const userA = randomUUID();
    const userB = randomUUID();
    for (let i = 0; i < 10; i += 1) {
      await service.create({ userId: userA, type: 'chat.message', payload: { i } });
    }
    await expect(
      service.create({ userId: userA, type: 'system.alert', payload: { i: 0 } }),
    ).resolves.toMatchObject({ status: 'created' });
    await expect(
      service.create({ userId: userB, type: 'chat.message', payload: { i: 0 } }),
    ).resolves.toMatchObject({ status: 'created' });
  });

  it('гонки одинаковых запросов → одна строка, occurrences=20', async () => {
    const userId = randomUUID();
    const payload = { orderId: 42 };
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        service.create({ userId, type: 'order.status_changed', payload }),
      ),
    );
    const created = results.filter((r) => r.status === 'created');
    expect(created).toHaveLength(1);
    const maxOcc = Math.max(...results.map((r) => r.notification.occurrences));
    expect(maxOcc).toBe(20);
    const count = await sql<{ n: string }>`
      select count(*)::text as n from notifications where user_id = ${userId}::uuid
    `.execute(kysely.db);
    expect(count.rows[0]?.n).toBe('1');
  });

  it('гонки на лимите → ровно 10 строк', async () => {
    const userId = randomUUID();
    const results = await Promise.allSettled(
      Array.from({ length: 30 }, (_, i) =>
        service.create({ userId, type: 'chat.message', payload: { i } }),
      ),
    );
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(10);
    expect(rejected).toHaveLength(20);
    const count = await sql<{ n: string }>`
      select count(*)::text as n from notifications where user_id = ${userId}::uuid
    `.execute(kysely.db);
    expect(count.rows[0]?.n).toBe('10');
  });

  it('схлопывание в непрочитанный якорь не тратит rate-limit', async () => {
    const userId = randomUUID();
    await service.create({
      userId,
      type: 'order.status_changed',
      payload: { orderId: 1 },
    });

    for (let i = 0; i < 9; i += 1) {
      const dup = await service.create({
        userId,
        type: 'order.status_changed',
        payload: { orderId: 1 },
      });
      expect(dup.status).toBe('deduplicated');
    }

    // В окне лимита принята одна строка, поэтому остаётся место под другие payload.
    const other = await service.create({
      userId,
      type: 'order.status_changed',
      payload: { orderId: 2 },
    });
    expect(other.status).toBe('created');
  });

  it('дубль после прочтения якоря → новая строка, прочитанная остаётся прочитанной', async () => {
    const userId = randomUUID();
    const payload = { orderId: 1 };
    const first = await service.create({ userId, type: 'order.status_changed', payload });
    await service.markAsRead(userId, first.notification.id);

    const second = await service.create({ userId, type: 'order.status_changed', payload });

    // Пользователь уже отреагировал на первое событие — повтор не должен пропасть.
    expect(second.status).toBe('created');
    expect(second.notification.id).not.toBe(first.notification.id);
    expect(second.notification.readAt).toBeNull();
    expect(second.notification.occurrences).toBe(1);

    const rows = await sql<{ id: string; read_at: Date | null }>`
      select id, read_at from notifications where user_id = ${userId}::uuid order by created_at
    `.execute(kysely.db);
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows[0]?.read_at).not.toBeNull();
    expect(rows.rows[1]?.read_at).toBeNull();

    const unread = await service.listUnread(userId, 10, undefined);
    expect(unread.items).toHaveLength(1);
    expect(unread.items[0]?.id).toBe(second.notification.id);
  });

  it('дубли после прочтения не схлопываются в прочитанный якорь навсегда', async () => {
    const userId = randomUUID();
    const payload = { orderId: 5 };
    const first = await service.create({ userId, type: 'order.status_changed', payload });
    await service.markAsRead(userId, first.notification.id);

    // Второй якорь непрочитан — следующие дубли схлопываются уже в него.
    const second = await service.create({ userId, type: 'order.status_changed', payload });
    const third = await service.create({ userId, type: 'order.status_changed', payload });

    expect(second.status).toBe('created');
    expect(third.status).toBe('deduplicated');
    expect(third.notification.id).toBe(second.notification.id);
    expect(third.notification.occurrences).toBe(2);
  });
});
