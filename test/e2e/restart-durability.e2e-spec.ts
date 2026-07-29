import { randomUUID } from 'node:crypto';

import { type INestApplication } from '@nestjs/common';
import { sql } from 'kysely';
import { io, type Socket } from 'socket.io-client';
import request from 'supertest';

import { KyselyService } from '@/database/kysely.service';

import { closeE2eApp, createE2eApp } from '../setup/e2e-app';
import { truncateAll } from '../setup/testcontainers';

/** Таймаут ожидания ack на стороне сервера в этом файле. */
const ACK_TIMEOUT_MS = 400;

/**
 * Запущенный экземпляр приложения.
 */
interface Instance {
  app: INestApplication;
  kysely: KyselyService;
  namespaceUrl: string;
}

/**
 * Проверка R2: уведомления не теряются при рестарте сервера.
 *
 * Зачем отдельный файл: остальные e2e поднимают приложение один раз на describe и потому не могут
 * доказать главное — что состояние доставки живёт в PostgreSQL, а не в памяти процесса. Здесь
 * приложение поднимается, полностью останавливается (`app.close()` = SIGTERM в docker/Railway)
 * и поднимается заново на той же БД: новый процесс, пустой PresenceRegistry, пустой буфер
 * DeliveredBatchWriter, новые Socket.IO-соединения.
 */
describe('restart durability e2e', () => {
  const openApps: Instance[] = [];
  const openSockets = new Set<Socket>();

  beforeAll(() => {
    process.env['AUTH_DEV_TOKENS_ENABLED'] = 'true';
    process.env['WS_ACK_TIMEOUT_MS'] = String(ACK_TIMEOUT_MS);
    process.env['WS_BACKLOG_BATCH_SIZE'] = '10';
    process.env['WS_BACKLOG_MAX_PAGES'] = '5';
    // Sweeper дожимал бы недоставленные в фоне и смазывал картину «что именно пришло после старта».
    process.env['SWEEPER_ENABLED'] = 'false';
  });

  afterEach(async () => {
    for (const socket of openSockets) {
      socket.removeAllListeners();
      socket.close();
    }
    openSockets.clear();

    // Чистим БД последним живым инстансом: после close пул уже недоступен.
    const last = openApps[openApps.length - 1];
    if (last !== undefined) {
      await truncateAll(last.kysely.db);
    }
    for (const instance of [...openApps].reverse()) {
      await closeE2eApp(instance.app);
    }
    openApps.length = 0;
  });

  /**
   * Поднимает новый экземпляр приложения на той же БД.
   *
   * @returns Инстанс с доступом к БД и URL WS-namespace
   */
  async function boot(): Promise<Instance> {
    const created = await createE2eApp({ listen: true });
    if (created.baseUrl === undefined) {
      throw new Error('e2e app must listen for Socket.IO');
    }
    const instance: Instance = {
      app: created.app,
      kysely: created.moduleRef.get(KyselyService),
      namespaceUrl: `${created.baseUrl}/ws/notifications`,
    };
    openApps.push(instance);
    return instance;
  }

  /**
   * Останавливает инстанс, как это делает оркестратор при рестарте.
   *
   * Зачем: `app.close()` прогоняет shutdown-хуки (flush delivered_at, закрытие пула и Socket.IO) —
   * ровно то, что должно случиться по SIGTERM перед подъёмом новой версии.
   *
   * @param instance - останавливаемый экземпляр
   * @returns void
   */
  async function stop(instance: Instance): Promise<void> {
    const index = openApps.indexOf(instance);
    if (index !== -1) {
      openApps.splice(index, 1);
    }
    await closeE2eApp(instance.app);
  }

  /**
   * Выдаёт JWT через dev-эндпоинт.
   *
   * @param app - приложение
   * @param userId - субъект токена
   * @param role - роль актора
   * @returns Bearer-токен
   */
  async function issueToken(
    app: INestApplication,
    userId: string,
    role: 'user' | 'service',
  ): Promise<string> {
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/dev-token')
      .send({ userId, role })
      .expect(201);
    return res.body.token as string;
  }

  /**
   * Создаёт уведомление от имени сервиса.
   *
   * @param app - приложение
   * @param serviceToken - токен с ролью service
   * @param userId - получатель
   * @param text - payload.text
   * @returns id созданного уведомления
   */
  async function createNotification(
    app: INestApplication,
    serviceToken: string,
    userId: string,
    text: string,
  ): Promise<string> {
    const res = await request(app.getHttpServer())
      .post('/api/v1/notifications')
      .set('Authorization', `Bearer ${serviceToken}`)
      .send({ userId, type: 'chat.message', payload: { text } })
      .expect(201);
    return res.body.notification.id as string;
  }

  /**
   * Подключает WS-клиента и ждёт `connection.ready`.
   *
   * @param namespaceUrl - URL namespace
   * @param token - JWT
   * @param handlers - подписки на события
   * @param handlers.onBacklog - обработчик `notification.backlog`
   * @param handlers.onCreated - обработчик `notification.created`
   * @returns Подключённый сокет
   */
  async function connectClient(
    namespaceUrl: string,
    token: string,
    handlers: {
      onBacklog?: (
        payload: { items: { id: string }[]; hasMore: boolean },
        ack?: () => void,
      ) => void;
      onCreated?: (dto: { id: string }, ack?: () => void) => void;
    } = {},
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
    if (handlers.onBacklog !== undefined) {
      socket.on('notification.backlog', handlers.onBacklog);
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
   * Читает delivered_at и read_at напрямую из БД.
   *
   * @param instance - инстанс с живым пулом
   * @param ids - идентификаторы уведомлений
   * @returns Строки в порядке created_at
   */
  async function readRows(
    instance: Instance,
    ids: readonly string[],
  ): Promise<{ id: string; delivered_at: Date | null; read_at: Date | null }[]> {
    const idList = sql.join(ids.map((id) => sql`${id}::uuid`));
    const result = await sql<{ id: string; delivered_at: Date | null; read_at: Date | null }>`
      select id, delivered_at, read_at
      from notifications
      where id in (${idList})
      order by created_at
    `.execute(instance.kysely.db);
    return result.rows;
  }

  /**
   * Ждёт указанное число миллисекунд.
   *
   * @param ms - задержка
   * @returns void
   */
  async function sleep(ms: number): Promise<void> {
    await new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  }

  it('созданные до рестарта уведомления приходят backlog-ом после подъёма нового процесса', async () => {
    const userId = randomUUID();
    const first = await boot();
    const userToken = await issueToken(first.app, userId, 'user');
    const serviceToken = await issueToken(first.app, randomUUID(), 'service');

    // Клиент офлайн: подключений нет вообще, живой push невозможен.
    const expectedIds = [
      await createNotification(first.app, serviceToken, userId, 'before-restart-1'),
      await createNotification(first.app, serviceToken, userId, 'before-restart-2'),
      await createNotification(first.app, serviceToken, userId, 'before-restart-3'),
    ];

    await stop(first);
    const second = await boot();

    // Токен переиспользуем намеренно: JWT stateless, новый процесс не обязан ничего «помнить».
    const receivedIds: string[] = [];
    let resolveDone!: () => void;
    const done = new Promise<void>((resolve, reject) => {
      resolveDone = resolve;
      setTimeout(() => {
        reject(new Error('timeout backlog after restart'));
      }, 5_000);
    });

    await connectClient(second.namespaceUrl, userToken, {
      onBacklog: (payload, ack) => {
        receivedIds.push(...payload.items.map((item) => item.id));
        ack?.();
        if (!payload.hasMore) {
          resolveDone();
        }
      },
    });

    await done;
    expect(receivedIds).toEqual(expectedIds);
  });

  it('неподтверждённая доставка не считается доставленной и повторяется после рестарта', async () => {
    const userId = randomUUID();
    const first = await boot();
    const userToken = await issueToken(first.app, userId, 'user');
    const serviceToken = await issueToken(first.app, randomUUID(), 'service');

    // Клиент подключён, но ack не отправляет: имитация «сервер упал сразу после push».
    await connectClient(first.namespaceUrl, userToken);
    const id = await createNotification(first.app, serviceToken, userId, 'unacked');
    await sleep(ACK_TIMEOUT_MS + 200);

    const beforeRestart = await readRows(first, [id]);
    expect(beforeRestart[0]?.delivered_at).toBeNull();

    await stop(first);
    const second = await boot();

    const receivedIds: string[] = [];
    let resolveDone!: () => void;
    const done = new Promise<void>((resolve, reject) => {
      resolveDone = resolve;
      setTimeout(() => {
        reject(new Error('timeout redelivery after restart'));
      }, 5_000);
    });

    await connectClient(second.namespaceUrl, userToken, {
      onBacklog: (payload, ack) => {
        receivedIds.push(...payload.items.map((item) => item.id));
        ack?.();
        if (!payload.hasMore) {
          resolveDone();
        }
      },
    });

    await done;
    expect(receivedIds).toEqual([id]);
  });

  it('подтверждённая доставка флашится на shutdown и после рестарта не дублируется', async () => {
    const userId = randomUUID();
    const first = await boot();
    const userToken = await issueToken(first.app, userId, 'user');
    const serviceToken = await issueToken(first.app, randomUUID(), 'service');

    const ackedIds: string[] = [];
    await connectClient(first.namespaceUrl, userToken, {
      onCreated: (dto, ack) => {
        ackedIds.push(dto.id);
        ack?.();
      },
    });

    const ids = [
      await createNotification(first.app, serviceToken, userId, 'acked-1'),
      await createNotification(first.app, serviceToken, userId, 'acked-2'),
    ];
    await sleep(200);
    expect(ackedIds).toEqual(ids);

    // Без flush в OnApplicationShutdown буфер delivered_at умер бы вместе с процессом,
    // и клиент получил бы те же уведомления повторно после рестарта.
    await stop(first);
    const second = await boot();

    const rows = await readRows(second, ids);
    expect(rows.map((row) => row.delivered_at)).toEqual([expect.any(Date), expect.any(Date)]);

    const backlogIds: string[] = [];
    await connectClient(second.namespaceUrl, userToken, {
      onBacklog: (payload, ack) => {
        backlogIds.push(...payload.items.map((item) => item.id));
        ack?.();
      },
    });
    await sleep(600);
    expect(backlogIds).toEqual([]);

    // Доставлено ≠ прочитано: уведомления пережили рестарт и остались непрочитанными.
    // Список непрочитанных идёт DESC по created_at — свежие сверху.
    const unread = await request(second.app.getHttpServer())
      .get('/api/v1/notifications/unread')
      .set('Authorization', `Bearer ${userToken}`)
      .expect(200);
    expect(unread.body.items.map((item: { id: string }) => item.id)).toEqual([...ids].reverse());
    expect(rows.map((row) => row.read_at)).toEqual([null, null]);
  });
});
