import { randomUUID } from 'node:crypto';

import { type INestApplication } from '@nestjs/common';
import { io, type Socket } from 'socket.io-client';
import request from 'supertest';

import { KyselyService } from '@/database/kysely.service';
import { type PresenceRegistry, PRESENCE_REGISTRY } from '@/realtime/presence.registry';

import { closeE2eApp, createE2eApp } from '../setup/e2e-app';
import { truncateAll } from '../setup/testcontainers';

describe('gateway connection e2e', () => {
  let app: INestApplication;
  let kysely: KyselyService;
  let presence: PresenceRegistry;
  let namespaceUrl: string;
  const openSockets = new Set<Socket>();

  /**
   * Выдаёт user JWT.
   *
   * @param userId - субъект
   * @returns токен
   */
  async function issueUserToken(userId: string): Promise<string> {
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/dev-token')
      .send({ userId, role: 'user' })
      .expect(201);
    return res.body.token as string;
  }

  /**
   * Подключается к namespace и ждёт connection.ready.
   *
   * @param token - JWT
   * @returns сокет и payload ready
   */
  async function connectReady(
    token: string,
  ): Promise<{ socket: Socket; ready: { unreadCount: number; unreadCountExact: boolean } }> {
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

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.close();
        reject(new Error('timeout waiting connection.ready'));
      }, 5_000);

      socket.on('connection.ready', (ready: { unreadCount: number; unreadCountExact: boolean }) => {
        clearTimeout(timer);
        resolve({ socket, ready });
      });
      socket.on('connection.error', (err: { code: string; message: string }) => {
        clearTimeout(timer);
        socket.close();
        reject(new Error(`connection.error: ${err.code}`));
      });
      socket.on('connect_error', (err: Error) => {
        clearTimeout(timer);
        socket.close();
        reject(err);
      });
    });
  }

  beforeAll(async () => {
    process.env['AUTH_DEV_TOKENS_ENABLED'] = 'true';
    const created = await createE2eApp({ listen: true });
    app = created.app;
    if (created.baseUrl === undefined) {
      throw new Error('e2e app must listen for Socket.IO');
    }
    namespaceUrl = `${created.baseUrl}/ws/notifications`;
    kysely = created.moduleRef.get(KyselyService);
    presence = created.moduleRef.get(PRESENCE_REGISTRY);
  });

  afterEach(async () => {
    for (const socket of openSockets) {
      socket.removeAllListeners();
      socket.close();
    }
    openSockets.clear();
    await truncateAll(kysely.db);
  });

  afterAll(async () => {
    await closeE2eApp(app);
  });

  it('валидный токен → connection.ready с unreadCount', async () => {
    const userId = randomUUID();
    const token = await issueUserToken(userId);
    const { ready } = await connectReady(token);
    expect(ready.unreadCount).toBe(0);
    expect(ready.unreadCountExact).toBe(true);
    expect(presence.isOnline(userId)).toBe(true);
  });

  it('без токена / мусорный токен → отказ', async () => {
    await new Promise<void>((resolve, reject) => {
      const socket = io(namespaceUrl, {
        transports: ['websocket'],
        auth: {},
        forceNew: true,
        reconnection: false,
      });
      openSockets.add(socket);
      const timer = setTimeout(() => {
        socket.close();
        reject(new Error('timeout'));
      }, 5_000);
      socket.on('connection.error', (err: { code: string }) => {
        clearTimeout(timer);
        expect(err.code).toBe('unauthorized');
        socket.close();
        resolve();
      });
      socket.on('connection.ready', () => {
        clearTimeout(timer);
        socket.close();
        reject(new Error('unexpected ready'));
      });
    });

    await new Promise<void>((resolve, reject) => {
      const socket = io(namespaceUrl, {
        transports: ['websocket'],
        auth: { token: 'not-a-jwt' },
        forceNew: true,
        reconnection: false,
      });
      openSockets.add(socket);
      const timer = setTimeout(() => {
        socket.close();
        reject(new Error('timeout'));
      }, 5_000);
      socket.on('connection.error', (err: { code: string }) => {
        clearTimeout(timer);
        expect(err.code).toBe('unauthorized');
        socket.close();
        resolve();
      });
      socket.on('connection.ready', () => {
        clearTimeout(timer);
        socket.close();
        reject(new Error('unexpected ready'));
      });
    });
  });

  it('после disconnect пользователь исчезает из presence', async () => {
    const userId = randomUUID();
    const token = await issueUserToken(userId);
    const { socket } = await connectReady(token);
    expect(presence.isOnline(userId)).toBe(true);

    await new Promise<void>((resolve) => {
      socket.on('disconnect', () => {
        resolve();
      });
      socket.close();
    });

    // handleDisconnect на сервере может отработать чуть позже client disconnect.
    let offline = false;
    for (let i = 0; i < 40; i += 1) {
      if (!presence.isOnline(userId)) {
        offline = true;
        break;
      }
      await new Promise((resolve) => {
        setTimeout(resolve, 25);
      });
    }
    expect(offline).toBe(true);
  });

  it('11-е соединение на пользователя отклоняется', async () => {
    const userId = randomUUID();
    const token = await issueUserToken(userId);

    for (let i = 0; i < 10; i += 1) {
      await connectReady(token);
    }
    expect(presence.socketCount(userId)).toBe(10);

    await new Promise<void>((resolve, reject) => {
      const socket = io(namespaceUrl, {
        transports: ['websocket'],
        auth: { token },
        forceNew: true,
        reconnection: false,
      });
      openSockets.add(socket);
      const timer = setTimeout(() => {
        socket.close();
        reject(new Error('timeout waiting too_many_connections'));
      }, 5_000);
      socket.on('connection.error', (err: { code: string }) => {
        clearTimeout(timer);
        expect(err.code).toBe('too_many_connections');
        socket.close();
        resolve();
      });
      socket.on('connection.ready', () => {
        clearTimeout(timer);
        socket.close();
        reject(new Error('11th connection should be rejected'));
      });
    });
  });
});
