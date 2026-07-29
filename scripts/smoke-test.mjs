#!/usr/bin/env node
/**
 * Smoke против живого стенда (локально или Railway).
 *
 * Зачем: ревьюер одной командой проверяет HTTPS REST + WSS.
 * Как: health → tokens → WS connect → create → live event → unread → mark read.
 *
 * Usage:
 *   pnpm smoke https://your-app.up.railway.app
 *   BASE_URL=http://localhost:3001 pnpm smoke
 */

import { randomUUID } from 'node:crypto';

const baseUrl = (process.argv[2] ?? process.env.BASE_URL ?? 'http://localhost:3001').replace(
  /\/$/,
  '',
);

/**
 * Лог шага.
 *
 * @param {string} message
 * @returns {void}
 */
function log(message) {
  console.log(`[smoke] ${message}`);
}

/**
 * Падает с кодом 1.
 *
 * @param {string} message
 * @returns {never}
 */
function fail(message) {
  console.error(`[smoke] FAIL: ${message}`);
  process.exit(1);
}

/**
 * JSON fetch.
 *
 * @param {string} path
 * @param {RequestInit} [init]
 * @returns {Promise<{ status: number; body: any }>}
 */
async function api(path, init = {}) {
  const res = await fetch(`${baseUrl}${path}`, init);
  const text = await res.text();
  let body = null;
  try {
    body = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

/**
 * Выдаёт dev-токен.
 *
 * @param {string} userId
 * @param {'user' | 'service'} role
 * @returns {Promise<string>}
 */
async function issueToken(userId, role) {
  const res = await api('/api/v1/auth/dev-token', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userId, role }),
  });
  if (res.status !== 201 || typeof res.body?.token !== 'string') {
    fail(`dev-token (${role}) → ${String(res.status)} (нужен AUTH_DEV_TOKENS_ENABLED=true)`);
  }
  return res.body.token;
}

/**
 * Ждёт notification.created или backlog с нужным id.
 *
 * @param {string} token
 * @param {() => Promise<string>} createFn - вызывается после connection.ready
 * @returns {Promise<string>} id доставленного уведомления
 */
async function connectAndReceive(token, createFn) {
  let io;
  try {
    ({ io } = await import('socket.io-client'));
  } catch {
    fail('Нужен socket.io-client (pnpm install) для проверки WSS');
  }

  const wsUrl = `${baseUrl}/ws/notifications`;
  log(`WS connect ${wsUrl}`);

  return new Promise((resolve, reject) => {
    const socket = io(wsUrl, {
      transports: ['websocket'],
      auth: { token },
      reconnection: false,
      timeout: 15_000,
    });

    /** @type {string | undefined} */
    let expectedId;
    /** @type {Set<string>} */
    const seenIds = new Set();
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error('timeout waiting WS delivery'));
    }, 20_000);

    /**
     * Проверяет совпадение id (событие может прийти раньше, чем вернётся create).
     *
     * @param {string | undefined} id
     * @returns {void}
     */
    const maybeDone = (id) => {
      if (typeof id !== 'string') {
        return;
      }
      seenIds.add(id);
      if (expectedId !== undefined && seenIds.has(expectedId)) {
        clearTimeout(timer);
        socket.close();
        resolve(expectedId);
      }
    };

    socket.on('connect_error', (err) => {
      clearTimeout(timer);
      socket.close();
      reject(err);
    });
    socket.on('connection.error', (err) => {
      clearTimeout(timer);
      socket.close();
      reject(new Error(err?.code ?? 'connection.error'));
    });
    socket.on('connection.ready', () => {
      void createFn()
        .then((id) => {
          expectedId = id;
          // Событие могло прийти раньше ответа create — перепроверим буфер.
          if (seenIds.has(id)) {
            clearTimeout(timer);
            socket.close();
            resolve(id);
          }
        })
        .catch((error) => {
          clearTimeout(timer);
          socket.close();
          reject(error);
        });
    });
    socket.on('notification.created', (dto, ack) => {
      if (typeof ack === 'function') {
        ack({ ok: true });
      }
      maybeDone(dto?.id);
    });
    socket.on('notification.backlog', (payload, ack) => {
      if (typeof ack === 'function') {
        ack({ ok: true });
      }
      for (const item of payload?.items ?? []) {
        maybeDone(item?.id);
      }
    });
  });
}

/**
 * Основной сценарий.
 *
 * @returns {Promise<void>}
 */
async function main() {
  log(`BASE_URL=${baseUrl}`);

  const live = await api('/health/live');
  if (live.status !== 200) {
    fail(`/health/live → ${String(live.status)}`);
  }
  log('health/live OK');

  const userId = randomUUID();
  const serviceToken = await issueToken(userId, 'service');
  const userToken = await issueToken(userId, 'user');
  log('tokens OK');

  const id = await connectAndReceive(userToken, async () => {
    const createRes = await api('/api/v1/notifications', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${serviceToken}`,
      },
      body: JSON.stringify({
        userId,
        type: 'chat.message',
        payload: { text: 'smoke' },
      }),
    });
    if (createRes.status !== 201 || typeof createRes.body?.notification?.id !== 'string') {
      throw new Error(`create → ${String(createRes.status)}`);
    }
    log(`create OK id=${createRes.body.notification.id}`);
    return createRes.body.notification.id;
  });
  log(`WS delivery OK id=${id}`);

  const unread = await api('/api/v1/notifications/unread?limit=20', {
    headers: { authorization: `Bearer ${userToken}` },
  });
  if (unread.status !== 200) {
    fail(`unread → ${String(unread.status)}`);
  }
  const found = (unread.body?.items ?? []).some((item) => item.id === id);
  if (!found) {
    fail('created notification missing in unread');
  }
  log('unread OK');

  const read = await api(`/api/v1/notifications/${id}/read`, {
    method: 'PATCH',
    headers: { authorization: `Bearer ${userToken}` },
  });
  if (read.status !== 200) {
    fail(`mark read → ${String(read.status)}`);
  }
  log('mark read OK');
  log('ALL GREEN');
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
