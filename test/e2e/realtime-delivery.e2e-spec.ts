import { randomUUID } from 'node:crypto';

import { type INestApplication } from '@nestjs/common';
import { sql } from 'kysely';
import { io, type Socket } from 'socket.io-client';
import request from 'supertest';

import { KyselyService } from '@/database/kysely.service';
import { DeliveredBatchWriter } from '@/realtime/delivered-batch.writer';

import { closeE2eApp, createE2eApp } from '../setup/e2e-app';
import { truncateAll } from '../setup/testcontainers';

describe('realtime delivery e2e', () => {
  let app: INestApplication;
  let kysely: KyselyService;
  let deliveredBatch: DeliveredBatchWriter;
  let namespaceUrl: string;
  const openSockets = new Set<Socket>();

  /**
   * Выдаёт JWT.
   *
   * @param userId - субъект
   * @param role - роль
   * @returns токен
   */
  async function issueToken(userId: string, role: 'user' | 'service' = 'user'): Promise<string> {
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/dev-token')
      .send({ userId, role })
      .expect(201);
    return res.body.token as string;
  }

  /**
   * Подключается и ждёт connection.ready.
   *
   * @param token - JWT
   * @param onCreated - опциональный обработчик notification.created (до ready)
   * @returns сокет
   */
  async function connectClient(
    token: string,
    onCreated?: (dto: { id: string }, ack?: (response?: unknown) => void) => void,
  ): Promise<Socket> {
    const socket = io(namespaceUrl, {
      transports: ['websocket'],
      auth: { token },
      forceNew: true,
      reconnection: false,
    });
    openSockets.add(socket);
    socket.on('disconnect', () => {
      openSockets.delete(socket);
    });

    if (onCreated !== undefined) {
      socket.on('notification.created', onCreated);
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

  beforeAll(async () => {
    process.env['AUTH_DEV_TOKENS_ENABLED'] = 'true';
    process.env['WS_ACK_TIMEOUT_MS'] = '500';

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
    for (const socket of openSockets) {
      socket.removeAllListeners();
      socket.close();
    }
    openSockets.clear();
    await deliveredBatch.flush();
    await truncateAll(kysely.db);
  });

  afterAll(async () => {
    await deliveredBatch.flush();
    await closeE2eApp(app);
  });

  it('онлайн-клиент получает notification.created < 200 мс; после ack delivered_at заполнен', async () => {
    const userId = randomUUID();
    const userToken = await issueToken(userId, 'user');
    const serviceToken = await issueToken(randomUUID(), 'service');

    let resolvePush!: (value: { id: string; receivedAt: number }) => void;
    const received = new Promise<{ id: string; receivedAt: number }>((resolve, reject) => {
      resolvePush = resolve;
      setTimeout(() => {
        reject(new Error('timeout waiting notification.created'));
      }, 3_000);
    });

    await connectClient(userToken, (dto: { id: string }, ack?: (response?: unknown) => void) => {
      if (typeof ack === 'function') {
        ack({ ok: true });
      }
      resolvePush({ id: dto.id, receivedAt: Date.now() });
    });

    const created = await request(app.getHttpServer())
      .post('/api/v1/notifications')
      .set('Authorization', `Bearer ${serviceToken}`)
      .send({ userId, type: 'chat.message', payload: { text: 'rt' } })
      .expect(201);
    const postEndedAt = Date.now();

    const push = await received;
    expect(push.receivedAt - postEndedAt).toBeLessThan(200);
    expect(push.id).toBe(created.body.notification.id);

    // Сервер обрабатывает ack асинхронно относительно client-side callback.
    await new Promise((resolve) => {
      setTimeout(resolve, 100);
    });
    await deliveredBatch.flush();

    const row = await sql<{ delivered: Date | null }>`
      select delivered_at as delivered from notifications where id = ${push.id}::uuid
    `.execute(kysely.db);
    expect(row.rows[0]?.delivered).toBeInstanceOf(Date);
  });

  it('без ack delivered_at остаётся NULL', async () => {
    const userId = randomUUID();
    const userToken = await issueToken(userId, 'user');
    const serviceToken = await issueToken(randomUUID(), 'service');

    let resolveId!: (id: string) => void;
    const received = new Promise<string>((resolve, reject) => {
      resolveId = resolve;
      setTimeout(() => {
        reject(new Error('timeout'));
      }, 3_000);
    });

    await connectClient(userToken, (dto: { id: string }) => {
      resolveId(dto.id);
    });

    await request(app.getHttpServer())
      .post('/api/v1/notifications')
      .set('Authorization', `Bearer ${serviceToken}`)
      .send({ userId, type: 'chat.message', payload: { text: 'no-ack' } })
      .expect(201);

    const id = await received;
    await new Promise((resolve) => {
      setTimeout(resolve, 700);
    });
    await deliveredBatch.flush();

    const row = await sql<{ delivered: Date | null }>`
      select delivered_at as delivered from notifications where id = ${id}::uuid
    `.execute(kysely.db);
    expect(row.rows[0]?.delivered).toBeNull();
  });

  it('схлопнутый дубль не порождает второй push', async () => {
    const userId = randomUUID();
    const userToken = await issueToken(userId, 'user');
    const serviceToken = await issueToken(randomUUID(), 'service');
    let pushCount = 0;
    await connectClient(userToken, (_dto: { id: string }, ack?: (response?: unknown) => void) => {
      pushCount += 1;
      if (typeof ack === 'function') {
        ack({ ok: true });
      }
    });

    const body = {
      userId,
      type: 'order.status_changed',
      payload: { orderId: 1, status: 'new' },
    };
    await request(app.getHttpServer())
      .post('/api/v1/notifications')
      .set('Authorization', `Bearer ${serviceToken}`)
      .send(body)
      .expect(201);

    await new Promise((resolve) => {
      setTimeout(resolve, 150);
    });
    expect(pushCount).toBe(1);

    await request(app.getHttpServer())
      .post('/api/v1/notifications')
      .set('Authorization', `Bearer ${serviceToken}`)
      .send({ ...body, payload: { orderId: 1, status: 'shipped' } })
      .expect(200);

    await new Promise((resolve) => {
      setTimeout(resolve, 150);
    });
    expect(pushCount).toBe(1);
  });

  it('notification.read из одной вкладки прилетает в другую', async () => {
    const userId = randomUUID();
    const userToken = await issueToken(userId, 'user');
    const serviceToken = await issueToken(randomUUID(), 'service');
    const autoAck = (_dto: { id: string }, ack?: (response?: unknown) => void): void => {
      if (typeof ack === 'function') {
        ack({ ok: true });
      }
    };
    const tabA = await connectClient(userToken, autoAck);
    const tabB = await connectClient(userToken, autoAck);

    const created = await request(app.getHttpServer())
      .post('/api/v1/notifications')
      .set('Authorization', `Bearer ${serviceToken}`)
      .send({ userId, type: 'chat.message', payload: { text: 'tabs' } })
      .expect(201);
    const id = created.body.notification.id as string;

    const readOnB = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('timeout read broadcast'));
      }, 3_000);
      tabB.on('notification.read', (payload: { id: string }) => {
        clearTimeout(timer);
        resolve(payload.id);
      });
    });

    await new Promise<void>((resolve, reject) => {
      tabA
        .timeout(3_000)
        .emit('notification.read', { id }, (err: Error | null, response: { ok?: boolean }) => {
          if (err !== null) {
            reject(err);
            return;
          }
          if (response.ok === true) {
            resolve();
            return;
          }
          reject(new Error(`read ack failed: ${JSON.stringify(response)}`));
        });
    });

    await expect(readOnB).resolves.toBe(id);
  });
});
