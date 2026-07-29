import { randomUUID } from 'node:crypto';

import { EventEmitterModule } from '@nestjs/event-emitter';
import { Test, type TestingModule } from '@nestjs/testing';
import { sql } from 'kysely';

import { AppConfigModule } from '@/common/config/config.module';
import { newUuidV7 } from '@/common/utils/uuid-v7';
import { DatabaseModule } from '@/database/database.module';
import { KyselyService } from '@/database/kysely.service';
import { NotificationNotFoundError } from '@/notifications/domain/errors';
import { NotificationsModule } from '@/notifications/notifications.module';
import { NotificationsService } from '@/notifications/notifications.service';

import { truncateAll } from '../setup/testcontainers';

describe('notifications read (integration)', () => {
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

  it('keyset-пагинация без пропусков и дублей', async () => {
    const userId = randomUUID();
    for (let i = 0; i < 5; i += 1) {
      await service.create({ userId, type: 'chat.message', payload: { i } });
    }
    const page1 = await service.listUnread(userId, 2, undefined);
    expect(page1.items).toHaveLength(2);
    expect(page1.nextCursor).not.toBeNull();
    const page2 = await service.listUnread(userId, 2, page1.nextCursor ?? undefined);
    expect(page2.items).toHaveLength(2);
    const page3 = await service.listUnread(userId, 2, page2.nextCursor ?? undefined);
    expect(page3.items).toHaveLength(1);
    expect(page3.nextCursor).toBeNull();

    const ids = [...page1.items, ...page2.items, ...page3.items].map((n) => n.id);
    expect(new Set(ids).size).toBe(5);
  });

  it('повторный markAsRead идемпотентен; чужое → 404', async () => {
    const userId = randomUUID();
    const created = await service.create({
      userId,
      type: 'chat.message',
      payload: { text: 'x' },
    });
    const first = await service.markAsRead(userId, created.notification.id);
    const second = await service.markAsRead(userId, created.notification.id);
    expect(first.readAt).not.toBeNull();
    expect(second.readAt?.getTime()).toBe(first.readAt?.getTime());

    await expect(service.markAsRead(randomUUID(), created.notification.id)).rejects.toBeInstanceOf(
      NotificationNotFoundError,
    );
  });

  it('countUnread отдаёт exact=false при превышении cap', async () => {
    const userId = randomUUID();
    for (let i = 0; i < 5; i += 1) {
      await service.create({ userId, type: 'chat.message', payload: { i } });
    }
    const capped = await service.countUnread(userId, 3);
    expect(capped).toEqual({ count: 3, exact: false });
    const exact = await service.countUnread(userId, 100);
    expect(exact).toEqual({ count: 5, exact: true });
  });

  it('markAllAsRead обновляет все непрочитанные', async () => {
    const userId = randomUUID();
    for (let i = 0; i < 3; i += 1) {
      await service.create({ userId, type: 'chat.message', payload: { i } });
    }
    const result = await service.markAllAsRead(userId);
    expect(result.updated).toBe(3);
    const unread = await service.countUnread(userId);
    expect(unread.count).toBe(0);
  });

  it('EXPLAIN markAsRead сканирует одну партицию; unread использует индекс', async () => {
    const userId = randomUUID();
    const created = await service.create({
      userId,
      type: 'chat.message',
      payload: { text: 'plan' },
    });
    const id = created.notification.id;
    const createdAt = created.notification.createdAt;

    const markPlan = await sql<{ 'QUERY PLAN': string }>`
      explain (format text)
      update notifications set read_at = clock_timestamp()
      where id = ${id}::uuid and created_at = ${createdAt} and user_id = ${userId}::uuid and read_at is null
    `.execute(kysely.db);
    const markText = markPlan.rows.map((r) => r['QUERY PLAN']).join('\n');
    expect(markText).toMatch(/notifications_\d{4}_\d{2}/);
    expect(markText.toLowerCase()).not.toContain('notifications_default');

    const unreadPlan = await sql<{ 'QUERY PLAN': string }>`
      explain (format text)
      select id from notifications
      where user_id = ${userId}::uuid and read_at is null
      order by created_at desc, id desc
      limit 20
    `.execute(kysely.db);
    const unreadText = unreadPlan.rows.map((r) => r['QUERY PLAN']).join('\n');
    expect(unreadText).toMatch(/unread|Index/i);

    // sanity: uuidv7 helper still used in codebase
    expect(newUuidV7(Date.now())).toBeTruthy();
  });
});
