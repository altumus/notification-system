import { randomUUID } from 'node:crypto';

import { type INestApplication } from '@nestjs/common';
import { sql } from 'kysely';
import { io, type Socket } from 'socket.io-client';
import request from 'supertest';

import { KyselyService } from '@/database/kysely.service';
import type { Notification } from '@/notifications/domain/notification.entity';
import { DeliveredBatchWriter } from '@/realtime/delivered-batch.writer';
import { NotificationsGateway } from '@/realtime/notifications.gateway';
import { UndeliveredSweeper } from '@/realtime/undelivered.sweeper';

import { closeE2eApp, createE2eApp } from '../setup/e2e-app';
import { truncateAll } from '../setup/testcontainers';

/**
 * Общие helpers для offline-backlog e2e.
 */
function createHelpers(getApp: () => INestApplication, getNamespaceUrl: () => string) {
  const openSockets = new Set<Socket>();

  /**
   * Выдаёт JWT.
   *
   * @param userId - субъект
   * @param role - роль
   * @returns токен
   */
  async function issueToken(userId: string, role: 'user' | 'service' = 'user'): Promise<string> {
    const res = await request(getApp().getHttpServer())
      .post('/api/v1/auth/dev-token')
      .send({ userId, role })
      .expect(201);
    return res.body.token as string;
  }

  /**
   * Создаёт уведомление.
   *
   * @param serviceToken - JWT service
   * @param userId - получатель
   * @param text - payload.text
   * @returns id
   */
  async function createNotification(
    serviceToken: string,
    userId: string,
    text: string,
  ): Promise<string> {
    const res = await request(getApp().getHttpServer())
      .post('/api/v1/notifications')
      .set('Authorization', `Bearer ${serviceToken}`)
      .send({ userId, type: 'chat.message', payload: { text } })
      .expect(201);
    return res.body.notification.id as string;
  }

  /**
   * Подключается к namespace.
   *
   * @param token - JWT
   * @param handlers - колбэки событий
   * @param handlers.onBacklog - обработка `notification.backlog`
   * @param handlers.onCreated - обработка `notification.created`
   * @returns сокет
   */
  async function connectClient(
    token: string,
    handlers: {
      onBacklog?: (
        payload: { items: { id: string }[]; batch: number; hasMore: boolean },
        ack: ((response?: unknown) => void) | undefined,
        socket: Socket,
      ) => void;
      onCreated?: (dto: { id: string }, ack?: (response?: unknown) => void) => void;
    } = {},
  ): Promise<Socket> {
    const socket = io(getNamespaceUrl(), {
      transports: ['websocket'],
      auth: { token },
      forceNew: true,
      reconnection: false,
    });
    openSockets.add(socket);
    socket.on('disconnect', () => {
      openSockets.delete(socket);
    });

    if (handlers.onBacklog !== undefined) {
      const onBacklog = handlers.onBacklog;
      socket.on(
        'notification.backlog',
        (
          payload: { items: { id: string }[]; batch: number; hasMore: boolean },
          ack?: (response?: unknown) => void,
        ) => {
          onBacklog(payload, ack, socket);
        },
      );
    }
    if (handlers.onCreated !== undefined) {
      socket.on('notification.created', handlers.onCreated);
    }

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.close();
        reject(new Error('timeout connection.ready'));
      }, 5_000);
      socket.on('connection.ready', () => {
        clearTimeout(timer);
        resolve();
      });
      socket.on('connection.error', (err: { code: string }) => {
        clearTimeout(timer);
        socket.close();
        reject(new Error(err.code));
      });
    });

    return socket;
  }

  /**
   * Закрывает все открытые сокеты.
   *
   * @returns void
   */
  function closeAllSockets(): void {
    for (const socket of openSockets) {
      socket.removeAllListeners();
      socket.close();
    }
    openSockets.clear();
  }

  return { issueToken, createNotification, connectClient, closeAllSockets };
}

describe('offline backlog e2e', () => {
  let app: INestApplication;
  let kysely: KyselyService;
  let deliveredBatch: DeliveredBatchWriter;
  let gateway: NotificationsGateway;
  let sweeper: UndeliveredSweeper;
  let namespaceUrl: string;
  const helpers = createHelpers(
    () => app,
    () => namespaceUrl,
  );

  beforeAll(async () => {
    process.env['AUTH_DEV_TOKENS_ENABLED'] = 'true';
    process.env['WS_ACK_TIMEOUT_MS'] = '500';
    process.env['WS_BACKLOG_BATCH_SIZE'] = '2';
    process.env['WS_BACKLOG_MAX_PAGES'] = '5';
    process.env['SWEEPER_ENABLED'] = 'true';
    process.env['SWEEPER_INTERVAL_MS'] = '60000';
    process.env['SWEEPER_MIN_AGE_MS'] = '0';

    const created = await createE2eApp({ listen: true });
    app = created.app;
    if (created.baseUrl === undefined) {
      throw new Error('e2e app must listen for Socket.IO');
    }
    namespaceUrl = `${created.baseUrl}/ws/notifications`;
    kysely = created.moduleRef.get(KyselyService);
    deliveredBatch = created.moduleRef.get(DeliveredBatchWriter);
    gateway = created.moduleRef.get(NotificationsGateway);
    sweeper = created.moduleRef.get(UndeliveredSweeper);
  });

  afterEach(async () => {
    helpers.closeAllSockets();
    jest.restoreAllMocks();
    await deliveredBatch.flush();
    await truncateAll(kysely.db);
  });

  afterAll(async () => {
    await deliveredBatch.flush();
    await closeE2eApp(app);
  });

  it('офлайн → 3 POST → connect → все 3 в notification.backlog по created_at', async () => {
    const userId = randomUUID();
    const userToken = await helpers.issueToken(userId, 'user');
    const serviceToken = await helpers.issueToken(randomUUID(), 'service');

    const id1 = await helpers.createNotification(serviceToken, userId, 'a');
    const id2 = await helpers.createNotification(serviceToken, userId, 'b');
    const id3 = await helpers.createNotification(serviceToken, userId, 'c');

    const receivedIds: string[] = [];
    let resolveDone!: () => void;
    const done = new Promise<void>((resolve, reject) => {
      resolveDone = resolve;
      setTimeout(() => {
        reject(new Error('timeout backlog'));
      }, 5_000);
    });

    await helpers.connectClient(userToken, {
      onBacklog: (payload, ack) => {
        for (const item of payload.items) {
          receivedIds.push(item.id);
        }
        if (ack !== undefined) {
          ack({ ok: true });
        }
        if (!payload.hasMore) {
          resolveDone();
        }
      },
    });

    await done;
    expect(receivedIds).toEqual([id1, id2, id3]);
    await deliveredBatch.flush();
  });

  it('частичный ack: после реконнекта приходят только неподтверждённые', async () => {
    const userId = randomUUID();
    const userToken = await helpers.issueToken(userId, 'user');
    const serviceToken = await helpers.issueToken(randomUUID(), 'service');

    const ids = [
      await helpers.createNotification(serviceToken, userId, '1'),
      await helpers.createNotification(serviceToken, userId, '2'),
      await helpers.createNotification(serviceToken, userId, '3'),
      await helpers.createNotification(serviceToken, userId, '4'),
    ];

    let sawFirst = false;
    const firstBatch = await new Promise<string[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('timeout first backlog'));
      }, 5_000);
      void helpers.connectClient(userToken, {
        onBacklog: (payload, ack, socket) => {
          if (sawFirst) {
            // Вторую страницу не подтверждаем — соединение уже рвём после первой.
            return;
          }
          sawFirst = true;
          if (ack !== undefined) {
            ack({ ok: true });
          }
          clearTimeout(timer);
          resolve(payload.items.map((item) => item.id));
          socket.close();
        },
      });
    });

    expect(firstBatch).toEqual([ids[0], ids[1]]);
    await deliveredBatch.flush();
    await new Promise((r) => {
      setTimeout(r, 150);
    });

    const secondIds: string[] = [];
    let resolveSecond!: () => void;
    const secondDone = new Promise<void>((resolve, reject) => {
      resolveSecond = resolve;
      setTimeout(() => {
        reject(new Error('timeout second backlog'));
      }, 5_000);
    });

    await helpers.connectClient(userToken, {
      onBacklog: (payload, ack) => {
        for (const item of payload.items) {
          secondIds.push(item.id);
        }
        if (ack !== undefined) {
          ack({ ok: true });
        }
        if (!payload.hasMore) {
          resolveSecond();
        }
      },
    });

    await secondDone;
    expect(secondIds).toEqual([ids[2], ids[3]]);
    await deliveredBatch.flush();
  });

  it('сломанный live-push → sweeper дожимает', async () => {
    const userId = randomUUID();
    const userToken = await helpers.issueToken(userId, 'user');
    const serviceToken = await helpers.issueToken(randomUUID(), 'service');

    const original = gateway.deliverCreated.bind(gateway);
    let failLive = true;
    jest.spyOn(gateway, 'deliverCreated').mockImplementation(async (notification: Notification) => {
      if (failLive) {
        return false;
      }
      return original(notification);
    });

    let resolvePush!: (id: string) => void;
    const pushed = new Promise<string>((resolve, reject) => {
      resolvePush = resolve;
      setTimeout(() => {
        reject(new Error('timeout sweeper push'));
      }, 5_000);
    });

    await helpers.connectClient(userToken, {
      onCreated: (dto, ack) => {
        if (typeof ack === 'function') {
          ack({ ok: true });
        }
        resolvePush(dto.id);
      },
      onBacklog: (_payload, ack) => {
        if (ack !== undefined) {
          ack({ ok: true });
        }
      },
    });

    const id = await helpers.createNotification(serviceToken, userId, 'sweep-me');

    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
    await deliveredBatch.flush();

    const before = await sql<{ delivered: Date | null }>`
      select delivered_at as delivered from notifications where id = ${id}::uuid
    `.execute(kysely.db);
    expect(before.rows[0]?.delivered).toBeNull();

    failLive = false;
    const deliveredCount = await sweeper.tick();
    expect(deliveredCount).toBeGreaterThanOrEqual(1);

    const pushId = await pushed;
    expect(pushId).toBe(id);

    await deliveredBatch.flush();
    const after = await sql<{ delivered: Date | null }>`
      select delivered_at as delivered from notifications where id = ${id}::uuid
    `.execute(kysely.db);
    expect(after.rows[0]?.delivered).toBeInstanceOf(Date);
  });
});

describe('offline backlog e2e (capped pages)', () => {
  let app: INestApplication;
  let kysely: KyselyService;
  let deliveredBatch: DeliveredBatchWriter;
  let namespaceUrl: string;
  const helpers = createHelpers(
    () => app,
    () => namespaceUrl,
  );

  beforeAll(async () => {
    process.env['AUTH_DEV_TOKENS_ENABLED'] = 'true';
    process.env['WS_ACK_TIMEOUT_MS'] = '500';
    process.env['WS_BACKLOG_BATCH_SIZE'] = '2';
    process.env['WS_BACKLOG_MAX_PAGES'] = '1';
    process.env['SWEEPER_ENABLED'] = 'false';

    const created = await createE2eApp({ listen: true });
    app = created.app;
    if (created.baseUrl === undefined) {
      throw new Error('e2e app must listen for Socket.IO');
    }
    namespaceUrl = `${created.baseUrl}/ws/notifications`;
    kysely = created.moduleRef.get(KyselyService);
    deliveredBatch = created.moduleRef.get(DeliveredBatchWriter);
  });

  afterEach(async () => {
    helpers.closeAllSockets();
    await deliveredBatch.flush();
    await truncateAll(kysely.db);
  });

  afterAll(async () => {
    await deliveredBatch.flush();
    await closeE2eApp(app);
  });

  it('backlog > лимита → hasMore: true и дотяжка через fetchUnread', async () => {
    const userId = randomUUID();
    const userToken = await helpers.issueToken(userId, 'user');
    const serviceToken = await helpers.issueToken(randomUUID(), 'service');

    for (let i = 0; i < 5; i += 1) {
      await helpers.createNotification(serviceToken, userId, `n${String(i)}`);
    }

    const socket = await new Promise<Socket>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('timeout backlog hasMore'));
      }, 5_000);
      void helpers
        .connectClient(userToken, {
          onBacklog: (payload, ack) => {
            expect(payload.items).toHaveLength(2);
            expect(payload.hasMore).toBe(true);
            if (ack !== undefined) {
              ack({ ok: true });
            }
            clearTimeout(timer);
          },
        })
        .then((s) => {
          setTimeout(() => {
            resolve(s);
          }, 100);
        });
    });

    await deliveredBatch.flush();

    const unread = await new Promise<{
      items: { id: string }[];
      nextCursor: string | null;
    }>((resolve, reject) => {
      socket
        .timeout(3_000)
        .emit(
          'notification.fetchUnread',
          { limit: 10 },
          (err: Error | null, response: { items: { id: string }[]; nextCursor: string | null }) => {
            if (err !== null) {
              reject(err);
              return;
            }
            resolve(response);
          },
        );
    });

    // fetchUnread отдаёт непрочитанные (все 5 ещё unread), не только undelivered.
    expect(unread.items.length).toBe(5);
  });
});
