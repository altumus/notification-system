/**
 * Клиент демо-страницы Notification System.
 *
 * Зачем: за минуту показать R5/R6/R7/R8/R9 без Postman.
 * Как: кнопки сценариев + REST/Socket.IO; дедуп событий по id; ack на live/backlog.
 */

const KNOWN_TYPES = [
  { type: 'order.status_changed', title: 'Статус заказа', sample: { orderId: 42, status: 'paid' } },
  { type: 'chat.message', title: 'Сообщение в чате', sample: { text: 'hello' } },
  {
    type: 'system.alert',
    title: 'Системное предупреждение',
    sample: { code: 'DISK', level: 'warn' },
  },
  {
    type: 'payment.failed',
    title: 'Ошибка оплаты',
    sample: { paymentId: 'pay_1', reason: 'card' },
  },
  {
    type: 'friend.request',
    title: 'Запрос в друзья',
    sample: { fromUserId: '11111111-1111-4111-8111-111111111111' },
  },
];

/** @type {Map<string, object>} */
const seenById = new Map();

const state = {
  token: /** @type {string | null} */ (null),
  socket: /** @type {import('socket.io-client').Socket | null} */ (null),
  lastIdempotencyKey: /** @type {string | null} */ (null),
  lastCreateBody: /** @type {object | null} */ (null),
  stats: { received: 0, deduped: 0, limited: 0, backlog: 0 },
  reconnecting: false,
  busy: false,
  /** @type {typeof import('socket.io-client').io | null} */
  io: null,
  /** @type {Map<string, { endsAt: number; windowMs: number }>} type → окно лимита */
  rateLimits: new Map(),
  /** @type {ReturnType<typeof setInterval> | null} */
  rateLimitTick: null,
};

/**
 * Загружает Socket.IO client: CDN, затем локальный фолбэк.
 *
 * @returns {Promise<typeof import('socket.io-client').io>}
 */
async function loadSocketIo() {
  try {
    const mod = await import('https://cdn.socket.io/4.8.1/socket.io.esm.min.js');
    return mod.io;
  } catch {
    const mod = await import('./vendor/socket.io.esm.min.js');
    return mod.io;
  }
}

/**
 * Генерирует UUID v4 для демо-пользователя.
 *
 * @returns {string}
 */
function newUuid() {
  return crypto.randomUUID();
}

/**
 * Возвращает элемент по id или бросает.
 *
 * @param {string} id
 * @returns {HTMLElement}
 */
function el(id) {
  const node = document.getElementById(id);
  if (node === null) {
    throw new Error(`Нет элемента #${id}`);
  }
  return node;
}

/**
 * @template {HTMLElement} T
 * @param {string} id
 * @returns {T}
 */
function typedEl(id) {
  return /** @type {T} */ (el(id));
}

/**
 * Базовый origin API (тот же хост, что и демо).
 *
 * @returns {string}
 */
function apiBase() {
  return window.location.origin;
}

/**
 * Короткое человекочитаемое описание HTTP-ответа.
 *
 * @param {number} status
 * @param {string} method
 * @param {string} path
 * @param {unknown} body
 * @param {Headers | undefined} headers
 * @returns {{ title: string; detail: string; kind: string }}
 */
function summarizeHttp(status, method, path, body, headers) {
  const data =
    body !== null && typeof body === 'object' ? /** @type {Record<string, any>} */ (body) : null;

  if (status === 0) {
    return {
      title: data?.error ? String(data.error) : 'Локальное сообщение',
      detail: path,
      kind: 'local',
    };
  }

  if (path.includes('/auth/dev-token')) {
    if (status >= 200 && status < 300) {
      return {
        title: 'Токен получен',
        detail: `user ${String(data?.userId ?? '').slice(0, 8)}… · роль ${String(data?.role ?? 'service')}`,
        kind: 'ok',
      };
    }
    return { title: 'Не удалось получить токен', detail: `${method} ${path}`, kind: 'err' };
  }

  if (path.includes('/notifications') && method === 'POST' && !path.includes('read')) {
    if (status === 201 && data?.status === 'created') {
      return {
        title: 'Создано новое уведомление',
        detail: `${String(data.notification?.type ?? '')} · id …${String(data.notification?.id ?? '').slice(-8)}`,
        kind: 'created',
      };
    }
    if (status === 200 && data?.status === 'deduplicated') {
      const occ = data.notification?.occurrences ?? '?';
      return {
        title: `Схлопнуто в существующее (×${String(occ)})`,
        detail: `${String(data.notification?.type ?? '')} · тот же id`,
        kind: 'dedup',
      };
    }
    if (status === 200 && headers?.get('idempotent-replay') === 'true') {
      return {
        title: 'Idempotency replay — тот же ответ',
        detail: 'Повтор с тем же ключом, новая сущность не создана',
        kind: 'idem',
      };
    }
    if (status === 200 && data?.notification?.id) {
      return {
        title: 'Ответ 200 (возможно replay)',
        detail: String(data.status ?? 'ok'),
        kind: 'ok',
      };
    }
    if (status === 429) {
      const retry = headers?.get('retry-after') ?? '?';
      return {
        title: 'Лимит превышен (429)',
        detail: `Подождите ~${String(retry)} с · смотрите таймер в блоке «Сессия»`,
        kind: 'limit',
      };
    }
  }

  if (path.includes('/unread') && status === 200) {
    const count = data?.unreadCount ?? data?.items?.length ?? 0;
    return { title: 'Список непрочитанных', detail: `${String(count)} шт.`, kind: 'ok' };
  }

  if (path.includes('/read') && status === 200) {
    return { title: 'Помечено прочитанным', detail: path, kind: 'ok' };
  }

  if (status >= 500) {
    return {
      title: 'Ошибка сервера',
      detail: `${method} ${path} → ${String(status)}`,
      kind: 'err',
    };
  }
  if (status >= 400) {
    const msg = data?.title ?? data?.detail ?? data?.message ?? data?.error ?? `${method} ${path}`;
    return { title: `Ошибка ${String(status)}`, detail: String(msg), kind: 'err' };
  }

  return {
    title: `${method} ${path}`,
    detail: `HTTP ${String(status)}`,
    kind: status >= 200 && status < 300 ? 'ok' : 'local',
  };
}

/**
 * Пишет строку в HTTP-лог: заголовок + раскрываемый JSON.
 *
 * @param {number} status
 * @param {string} method
 * @param {string} path
 * @param {unknown} body
 * @param {Headers | undefined} [headers]
 * @returns {void}
 */
function logHttp(status, method, path, body, headers) {
  const list = typedEl('httpLog');
  const summary = summarizeHttp(status, method, path, body, headers);
  const item = document.createElement('li');
  item.className = `log-item kind-${summary.kind}`;

  const statusClass =
    status === 201
      ? 'st-201'
      : status === 200
        ? 'st-200'
        : status === 429
          ? 'st-429'
          : status >= 400
            ? 'st-err'
            : status === 0
              ? 'st-local'
              : 'st-ok';

  const head = document.createElement('button');
  head.type = 'button';
  head.className = 'log-head-btn';
  head.innerHTML = `
    <span class="log-status ${statusClass}">${status === 0 ? '·' : String(status)}</span>
    <span class="log-text">
      <strong>${escapeHtml(summary.title)}</strong>
      <small>${escapeHtml(summary.detail)}</small>
    </span>
    <span class="log-chevron" aria-hidden="true">▾</span>
  `;

  const details = document.createElement('pre');
  details.className = 'log-json';
  details.hidden = true;
  details.textContent = `${method} ${path}\n${JSON.stringify(body, null, 2)}`;

  head.addEventListener('click', () => {
    details.hidden = !details.hidden;
    item.classList.toggle('open', !details.hidden);
  });

  item.append(head, details);
  list.prepend(item);
}

/**
 * Показывает баннер текущего сценария.
 *
 * @param {string | null} text
 * @returns {void}
 */
function setScenarioBanner(text) {
  const banner = typedEl('scenarioBanner');
  if (text === null || text.length === 0) {
    banner.hidden = true;
    banner.textContent = '';
    return;
  }
  banner.hidden = false;
  banner.textContent = text;
}

/**
 * Блокирует кнопки сценариев на время прогона.
 *
 * @param {boolean} busy
 * @returns {void}
 */
function setBusy(busy) {
  state.busy = busy;
  document.querySelectorAll('.scenario, #btnReady, #btnSend, #btnReplayIdem').forEach((node) => {
    if (node instanceof HTMLButtonElement) {
      node.disabled = busy;
    }
  });
}

/**
 * Обновляет счётчики сессии в UI.
 *
 * @returns {void}
 */
function renderStats() {
  for (const [key, value] of Object.entries(state.stats)) {
    const node = document.querySelector(`[data-stat="${key}"]`);
    if (node !== null) {
      node.textContent = String(value);
    }
  }
}

/**
 * Форматирует оставшиеся секунды как m:ss или Ns.
 *
 * @param {number} totalSec
 * @returns {string}
 */
function formatCountdown(totalSec) {
  const sec = Math.max(0, Math.ceil(totalSec));
  if (sec >= 60) {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${String(m)}:${String(s).padStart(2, '0')}`;
  }
  return `${String(sec)} с`;
}

/**
 * Рисует виджет rate-limit (активное окно с максимальным остатком).
 *
 * @returns {void}
 */
function renderRateLimitTimer() {
  const box = typedEl('rateLimitBox');
  const timeEl = typedEl('rateLimitCountdown');
  const detailEl = typedEl('rateLimitDetail');
  const bar = typedEl('rateLimitBar');
  const now = Date.now();

  for (const [type, info] of state.rateLimits) {
    if (info.endsAt <= now) {
      state.rateLimits.delete(type);
    }
  }

  /** @type {{ type: string; endsAt: number; windowMs: number } | null} */
  let active = null;
  for (const [type, info] of state.rateLimits) {
    if (active === null || info.endsAt > active.endsAt) {
      active = { type, endsAt: info.endsAt, windowMs: info.windowMs };
    }
  }

  if (active === null) {
    box.className = 'rate-limit idle';
    timeEl.textContent = 'окна свободны';
    detailEl.textContent = 'Лимит 10/мин на type · таймер появится после 429';
    bar.style.width = '0%';
    if (state.rateLimitTick !== null && state.rateLimits.size === 0) {
      clearInterval(state.rateLimitTick);
      state.rateLimitTick = null;
    }
    return;
  }

  const remainMs = Math.max(0, active.endsAt - now);
  const remainSec = remainMs / 1000;
  const windowMs = Math.max(active.windowMs, 1);
  const pct = Math.min(100, Math.max(0, (remainMs / windowMs) * 100));

  box.className = 'rate-limit active';
  timeEl.textContent = formatCountdown(remainSec);
  detailEl.textContent = `${active.type} · ещё ${formatCountdown(remainSec)} до снятия лимита`;
  bar.style.width = `${String(pct)}%`;
}

/**
 * Запускает/продлевает таймер по ответу 429.
 *
 * @param {string} type
 * @param {Headers} headers
 * @returns {void}
 */
function armRateLimitFromHeaders(type, headers) {
  const retryRaw = headers.get('retry-after') ?? headers.get('ratelimit-reset');
  const windowRaw = headers.get('x-ratelimit-window-ms');
  const retrySec = Number(retryRaw);
  if (!Number.isFinite(retrySec) || retrySec <= 0) {
    return;
  }
  const windowMs = Number(windowRaw);
  const endsAt = Date.now() + retrySec * 1000;
  state.rateLimits.set(type, {
    endsAt,
    windowMs: Number.isFinite(windowMs) && windowMs > 0 ? windowMs : retrySec * 1000,
  });
  if (state.rateLimitTick === null) {
    state.rateLimitTick = setInterval(() => {
      renderRateLimitTimer();
    }, 250);
  }
  renderRateLimitTimer();
}

/**
 * Показывает preview Idempotency-Key в форме.
 *
 * @returns {void}
 */
function syncIdemPreview() {
  const preview = typedEl('idemKeyPreview');
  const on = typedEl('useIdempotency').checked;
  if (!on) {
    preview.hidden = true;
    preview.textContent = '—';
    return;
  }
  if (state.lastIdempotencyKey === null) {
    state.lastIdempotencyKey = newUuid();
  }
  preview.hidden = false;
  preview.textContent = state.lastIdempotencyKey;
}

/**
 * Ставит badge состояния WS.
 *
 * @param {'connected' | 'reconnecting' | 'offline'} status
 * @returns {void}
 */
function setConnBadge(status) {
  const badge = typedEl('connBadge');
  badge.className = `badge ${status}`;
  badge.textContent =
    status === 'connected' ? 'online' : status === 'reconnecting' ? 'reconnect…' : 'offline';
}

/**
 * Заполняет select известных типов.
 *
 * @returns {void}
 */
function fillTypeSelect() {
  const select = typedEl('typeSelect');
  select.innerHTML = '';
  for (const item of KNOWN_TYPES) {
    const opt = document.createElement('option');
    opt.value = item.type;
    opt.textContent = `${item.title} (${item.type})`;
    select.append(opt);
  }
}

/**
 * Кладёт sample payload для выбранного типа.
 *
 * @returns {void}
 */
function applySamplePayload() {
  const custom = typedEl('typeCustom').value.trim();
  const type = custom.length > 0 ? custom : typedEl('typeSelect').value;
  const known = KNOWN_TYPES.find((item) => item.type === type);
  const payload = known?.sample ?? { note: 'custom' };
  typedEl('payload').value = JSON.stringify(payload, null, 2);
  validatePayload();
}

/**
 * Выставляет type/payload в форме (для ручной донастройки).
 *
 * @param {string} type
 * @param {object} payload
 * @returns {void}
 */
function setFormTypePayload(type, payload) {
  typedEl('typeCustom').value = '';
  typedEl('typeSelect').value = type;
  typedEl('payload').value = JSON.stringify(payload, null, 2);
  validatePayload();
}

/**
 * Валидирует JSON payload и подсвечивает ошибку.
 *
 * @returns {object | null}
 */
function validatePayload() {
  const area = typedEl('payload');
  const err = typedEl('payloadError');
  try {
    const parsed = JSON.parse(area.value);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('payload должен быть JSON-объектом');
    }
    area.classList.remove('is-invalid');
    err.hidden = true;
    err.textContent = '';
    return /** @type {object} */ (parsed);
  } catch (error) {
    area.classList.add('is-invalid');
    err.hidden = false;
    err.textContent = error instanceof Error ? error.message : 'Невалидный JSON';
    return null;
  }
}

/**
 * Синхронизирует target userId с текущим, если поле пустое.
 *
 * @returns {void}
 */
function syncTargetDefault() {
  const target = typedEl('targetUserId');
  if (target.value.trim().length === 0) {
    target.value = typedEl('userId').value.trim();
  }
}

/**
 * Выдаёт dev-JWT через /api/v1/auth/dev-token.
 *
 * @returns {Promise<boolean>}
 */
async function issueToken() {
  const userId = typedEl('userId').value.trim() || newUuid();
  typedEl('userId').value = userId;
  syncTargetDefault();

  const res = await fetch(`${apiBase()}/api/v1/auth/dev-token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userId, role: 'service' }),
  });
  const body = await res.json();
  logHttp(res.status, 'POST', '/api/v1/auth/dev-token', body, res.headers);
  if (!res.ok) {
    typedEl('tokenStatus').textContent = 'ошибка токена';
    return false;
  }
  state.token = body.token;
  typedEl('tokenStatus').textContent = `токен ok · ${userId.slice(0, 8)}…`;
  return true;
}

/**
 * Общий fetch к API с Bearer.
 *
 * @param {string} path
 * @param {RequestInit & { headers?: Record<string, string> }} init
 * @returns {Promise<{ status: number; body: unknown; headers: Headers }>}
 */
async function api(path, init = {}) {
  if (state.token === null) {
    throw new Error('Сначала получите dev-токен');
  }
  const headers = { ...(init.headers ?? {}), authorization: `Bearer ${state.token}` };
  if (init.body !== undefined && headers['content-type'] === undefined) {
    headers['content-type'] = 'application/json';
  }
  const res = await fetch(`${apiBase()}${path}`, { ...init, headers });
  const text = await res.text();
  let body = /** @type {unknown} */ (text);
  try {
    body = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    // оставляем text
  }
  logHttp(res.status, init.method ?? 'GET', path, body, res.headers);
  return { status: res.status, body, headers: res.headers };
}

/**
 * Создаёт одно уведомление (с опциональным Idempotency-Key).
 *
 * @param {object} body
 * @param {string | undefined} idempotencyKey
 * @returns {Promise<{ status: number; body: any; headers: Headers }>}
 */
async function createOnce(body, idempotencyKey) {
  const headers = {};
  if (idempotencyKey !== undefined) {
    headers['idempotency-key'] = idempotencyKey;
  }
  const result = await api('/api/v1/notifications', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  if (result.status === 200 && result.body?.status === 'deduplicated') {
    state.stats.deduped += 1;
    if (typeof result.body.notification?.id === 'string') {
      upsertUnread(result.body.notification, 'dedup');
    }
  } else if (result.status === 429) {
    state.stats.limited += 1;
    const type = typeof body?.type === 'string' ? body.type : 'unknown';
    armRateLimitFromHeaders(type, result.headers);
  }
  renderStats();
  return result;
}

/**
 * Отправляет N create с интервалом.
 *
 * @returns {Promise<void>}
 */
async function sendBurst() {
  const payload = validatePayload();
  if (payload === null) {
    return;
  }
  const custom = typedEl('typeCustom').value.trim();
  const type = custom.length > 0 ? custom : typedEl('typeSelect').value;
  const targetUserId = typedEl('targetUserId').value.trim() || typedEl('userId').value.trim();
  const count = Number(typedEl('sendCount').value);
  const intervalMs = Number(typedEl('sendInterval').value);
  const useIdem = typedEl('useIdempotency').checked;

  const body = { userId: targetUserId, type, payload };
  state.lastCreateBody = body;
  const key = useIdem ? (state.lastIdempotencyKey ?? newUuid()) : undefined;
  if (useIdem && key !== undefined) {
    state.lastIdempotencyKey = key;
    syncIdemPreview();
  }

  for (let i = 0; i < count; i += 1) {
    const nextBody =
      type === 'chat.message'
        ? {
            ...body,
            payload: { ...payload, text: `${String(payload.text ?? 'msg')}-${String(i)}` },
          }
        : body;
    await createOnce(nextBody, useIdem ? key : undefined);
    if (i < count - 1 && intervalMs > 0) {
      await sleep(intervalMs);
    }
  }
}

/**
 * Повторяет последний create с тем же Idempotency-Key.
 *
 * @returns {Promise<void>}
 */
async function replayIdempotent() {
  if (state.lastCreateBody === null || state.lastIdempotencyKey === null) {
    logHttp(0, 'LOCAL', 'idempotency-replay', { error: 'Нет предыдущего запроса с ключом' });
    return;
  }
  await createOnce(state.lastCreateBody, state.lastIdempotencyKey);
}

/**
 * Promise-обёртка setTimeout.
 *
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Ждёт connect сокета или таймаут.
 *
 * @param {number} [ms]
 * @returns {Promise<boolean>}
 */
function waitConnected(ms = 4000) {
  if (state.socket?.connected) {
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    const socket = state.socket;
    if (socket === null) {
      resolve(false);
      return;
    }
    const timer = setTimeout(() => {
      cleanup();
      resolve(socket.connected);
    }, ms);
    const onConnect = () => {
      cleanup();
      resolve(true);
    };
    const cleanup = () => {
      clearTimeout(timer);
      socket.off('connect', onConnect);
    };
    socket.once('connect', onConnect);
  });
}

/**
 * Гарантирует токен и (опционально) WS.
 *
 * @param {{ connect?: boolean }} [opts]
 * @returns {Promise<boolean>}
 */
async function ensureReady(opts = {}) {
  const wantConnect = opts.connect !== false;
  if (state.token === null) {
    const ok = await issueToken();
    if (!ok) {
      return false;
    }
  }
  if (wantConnect) {
    if (state.io === null) {
      return false;
    }
    if (state.socket === null || !state.socket.connected) {
      connectWs(state.io);
      const connected = await waitConnected();
      if (!connected) {
        logHttp(0, 'LOCAL', 'ws', { error: 'WebSocket не подключился' });
        return false;
      }
    }
  }
  return true;
}

/**
 * Подготовка сессии одной кнопкой.
 *
 * @returns {Promise<void>}
 */
async function prepareSession() {
  setBusy(true);
  setScenarioBanner('Готовим сессию: токен и WebSocket…');
  try {
    typedEl('userId').value = typedEl('userId').value.trim() || newUuid();
    syncTargetDefault();
    const ok = await issueToken();
    if (!ok || state.io === null) {
      setScenarioBanner('Не удалось получить токен. Проверьте AUTH_DEV_TOKENS_ENABLED.');
      return;
    }
    connectWs(state.io);
    const connected = await waitConnected();
    setScenarioBanner(
      connected
        ? 'Готово. Запускайте сценарии A → E.'
        : 'Токен есть, но WS не подключился — попробуйте Connect.',
    );
  } finally {
    setBusy(false);
  }
}

/**
 * Сценарий A: live-доставка одного сообщения.
 *
 * @returns {Promise<void>}
 */
async function scenarioLive() {
  setScenarioBanner('A · Live: отправляем 1 chat.message — смотрите ленту WS (badge live).');
  if (!(await ensureReady({ connect: true }))) {
    return;
  }
  const userId = typedEl('userId').value.trim();
  const payload = { text: `live-${Date.now()}` };
  setFormTypePayload('chat.message', payload);
  await createOnce({ userId, type: 'chat.message', payload }, undefined);
  setScenarioBanner('A · Готово: в ленте должно быть live, в HTTP — «Создано новое» (201).');
}

/**
 * Сценарий B: схлопывание дублей.
 *
 * @returns {Promise<void>}
 */
async function scenarioDedup() {
  setScenarioBanner('B · Dedup: один order.status_changed ×3 — ждите 201, затем два «Схлопнуто».');
  if (!(await ensureReady({ connect: true }))) {
    return;
  }
  const userId = typedEl('userId').value.trim();
  const orderId = Math.floor(Math.random() * 9000) + 100;
  const payload = { orderId, status: 'paid' };
  setFormTypePayload('order.status_changed', payload);
  const body = { userId, type: 'order.status_changed', payload };
  for (let i = 0; i < 3; i += 1) {
    await createOnce(body, undefined);
    if (i < 2) {
      await sleep(120);
    }
  }
  setScenarioBanner('B · Готово: одно уведомление с ×3, в ленте одно событие.');
}

/**
 * Сценарий C: rate limit.
 *
 * @returns {Promise<void>}
 */
async function scenarioRateLimit() {
  setScenarioBanner('C · Rate limit: 15 разных сообщений — после ~10 появятся 429.');
  if (!(await ensureReady({ connect: true }))) {
    return;
  }
  const userId = typedEl('userId').value.trim();
  setFormTypePayload('chat.message', { text: 'rate' });
  const stamp = Date.now();
  for (let i = 0; i < 15; i += 1) {
    await createOnce(
      { userId, type: 'chat.message', payload: { text: `rate-${String(stamp)}-${String(i)}` } },
      undefined,
    );
    if (i < 14) {
      await sleep(60);
    }
  }
  setScenarioBanner(
    `C · Готово: счётчик «лимит 429» = ${String(state.stats.limited)}. Жёлтые строки в логе — отказы.`,
  );
}

/**
 * Сценарий D: offline → backlog.
 *
 * @returns {Promise<void>}
 */
async function scenarioBacklog() {
  setScenarioBanner('D · Backlog: отключаем WS, шлём 3 сообщения, снова Connect…');
  if (!(await ensureReady({ connect: true }))) {
    return;
  }
  const userId = typedEl('userId').value.trim();
  disconnectWs();
  await sleep(200);
  const stamp = Date.now();
  for (let i = 0; i < 3; i += 1) {
    await createOnce(
      { userId, type: 'chat.message', payload: { text: `offline-${String(stamp)}-${String(i)}` } },
      undefined,
    );
    if (i < 2) {
      await sleep(80);
    }
  }
  if (state.io === null) {
    return;
  }
  setScenarioBanner('D · Подключаемся — в ленте ждите badge backlog…');
  connectWs(state.io);
  await waitConnected();
  await sleep(800);
  setScenarioBanner('D · Готово: в ленте события с badge backlog (или live, если успели).');
}

/**
 * Сценарий E: idempotency key.
 *
 * @returns {Promise<void>}
 */
async function scenarioIdempotency() {
  setScenarioBanner('E · Idempotency: два create с одним ключом.');
  if (!(await ensureReady({ connect: true }))) {
    return;
  }
  const userId = typedEl('userId').value.trim();
  const key = newUuid();
  const payload = { text: `idem-${Date.now()}` };
  const body = { userId, type: 'chat.message', payload };
  setFormTypePayload('chat.message', payload);
  typedEl('useIdempotency').checked = true;
  state.lastIdempotencyKey = key;
  state.lastCreateBody = body;
  syncIdemPreview();
  await createOnce(body, key);
  await sleep(200);
  await createOnce(body, key);
  setScenarioBanner('E · Готово: второй ответ — тот же id, без второго live-события.');
}

/**
 * Запускает сценарий по id.
 *
 * @param {string} id
 * @returns {Promise<void>}
 */
async function runScenario(id) {
  if (state.busy) {
    return;
  }
  setBusy(true);
  try {
    switch (id) {
      case 'live':
        await scenarioLive();
        break;
      case 'dedup':
        await scenarioDedup();
        break;
      case 'rateLimit':
        await scenarioRateLimit();
        break;
      case 'backlog':
        await scenarioBacklog();
        break;
      case 'idempotency':
        await scenarioIdempotency();
        break;
      default:
        logHttp(0, 'LOCAL', 'scenario', { error: `Неизвестный сценарий: ${id}` });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Ошибка сценария';
    logHttp(0, 'LOCAL', 'scenario', { error: message });
    setScenarioBanner(message);
  } finally {
    setBusy(false);
  }
}

/**
 * Подключает Socket.IO к namespace уведомлений.
 *
 * @param {typeof import('socket.io-client').io} io
 * @returns {void}
 */
function connectWs(io) {
  if (state.token === null) {
    logHttp(0, 'LOCAL', 'ws', { error: 'Нужен токен' });
    return;
  }
  disconnectWs();

  const socket = io(`${apiBase()}/ws/notifications`, {
    auth: { token: state.token },
    transports: ['websocket'],
    reconnection: true,
  });
  state.socket = socket;

  socket.on('connect', () => {
    state.reconnecting = false;
    setConnBadge('connected');
  });
  socket.io.on('reconnect_attempt', () => {
    state.reconnecting = true;
    setConnBadge('reconnecting');
  });
  socket.on('disconnect', () => {
    if (!state.reconnecting) {
      setConnBadge('offline');
    }
  });
  socket.on('connection.ready', (payload) => {
    typedEl('unreadCount').textContent = String(payload.unreadCount ?? 0);
    void refreshUnread();
  });
  socket.on('notification.created', (dto, ack) => {
    handleIncoming(dto, 'live');
    if (typeof ack === 'function') {
      ack({ ok: true });
    }
  });
  socket.on('notification.backlog', (payload, ack) => {
    const items = Array.isArray(payload?.items) ? payload.items : [];
    for (const dto of items) {
      handleIncoming(dto, 'backlog');
      state.stats.backlog += 1;
    }
    renderStats();
    if (typeof ack === 'function') {
      ack({ ok: true });
    }
  });
  socket.on('notification.read', (payload) => {
    if (typeof payload?.id === 'string') {
      removeUnread(payload.id);
    }
  });
}

/**
 * Рвёт WS без автореконнекта до следующего Connect.
 *
 * @returns {void}
 */
function disconnectWs() {
  if (state.socket !== null) {
    state.socket.io.opts.reconnection = false;
    state.socket.removeAllListeners();
    state.socket.disconnect();
    state.socket = null;
  }
  state.reconnecting = false;
  setConnBadge('offline');
}

/**
 * Обрабатывает входящее уведомление с дедупом по id.
 *
 * @param {object} dto
 * @param {'live' | 'backlog' | 'sweeper'} source
 * @returns {void}
 */
function handleIncoming(dto, source) {
  if (dto === null || typeof dto !== 'object' || typeof dto.id !== 'string') {
    return;
  }
  const existing = seenById.get(dto.id);
  if (existing !== undefined) {
    seenById.set(dto.id, dto);
    upsertUnread(dto, 'update');
    return;
  }
  seenById.set(dto.id, dto);
  state.stats.received += 1;
  renderStats();
  pushFeed(dto, source);
  upsertUnread(dto, 'add');
}

/**
 * Добавляет событие в живую ленту WS.
 *
 * @param {object} dto
 * @param {'live' | 'backlog' | 'sweeper'} source
 * @returns {void}
 */
function pushFeed(dto, source) {
  const list = typedEl('liveFeed');
  const item = document.createElement('li');
  const occ =
    typeof dto.occurrences === 'number' && dto.occurrences > 1
      ? ` <span class="occ">×${String(dto.occurrences)}</span>`
      : '';
  item.innerHTML = `<span class="source ${source}">${source}</span><strong>${escapeHtml(String(dto.type))}</strong>${occ}<div class="meta">${escapeHtml(String(dto.id))}</div>`;
  list.prepend(item);
}

/**
 * Экранирует HTML.
 *
 * @param {string} value
 * @returns {string}
 */
function escapeHtml(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/**
 * Вставляет/обновляет строку в списке непрочитанных.
 *
 * @param {object} dto
 * @param {'add' | 'update' | 'dedup'} _mode
 * @returns {void}
 */
function upsertUnread(dto, _mode) {
  const list = typedEl('unreadList');
  let item = list.querySelector(`[data-id="${cssEscape(dto.id)}"]`);
  if (item === null) {
    item = document.createElement('li');
    item.setAttribute('data-id', dto.id);
    list.prepend(item);
  }
  const occ =
    typeof dto.occurrences === 'number' && dto.occurrences > 1
      ? ` <span class="occ">×${String(dto.occurrences)}</span>`
      : '';
  item.innerHTML = `<strong>${escapeHtml(String(dto.type))}</strong>${occ}<div class="meta">${escapeHtml(JSON.stringify(dto.payload))}</div><div class="actions"><button type="button" data-read="${escapeHtml(dto.id)}">Прочитано</button></div>`;
  const btn = item.querySelector('button[data-read]');
  btn?.addEventListener('click', () => {
    void markRead(dto.id);
  });
  typedEl('unreadCount').textContent = String(list.children.length);
}

/**
 * Удаляет уведомление из списка непрочитанных.
 *
 * @param {string} id
 * @returns {void}
 */
function removeUnread(id) {
  const list = typedEl('unreadList');
  list.querySelector(`[data-id="${cssEscape(id)}"]`)?.remove();
  typedEl('unreadCount').textContent = String(list.children.length);
}

/**
 * Экранирует значение для CSS.escape / attribute selector.
 *
 * @param {string} value
 * @returns {string}
 */
function cssEscape(value) {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
    return CSS.escape(value);
  }
  return value.replaceAll(/["\\]/g, '\\$&');
}

/**
 * Тянет непрочитанные через REST.
 *
 * @returns {Promise<void>}
 */
async function refreshUnread() {
  const result = await api('/api/v1/notifications/unread?limit=50');
  if (result.status !== 200 || result.body === null || typeof result.body !== 'object') {
    return;
  }
  const body = /** @type {{ items?: object[]; unreadCount?: number }} */ (result.body);
  const list = typedEl('unreadList');
  list.innerHTML = '';
  for (const item of body.items ?? []) {
    if (item !== null && typeof item === 'object' && typeof item.id === 'string') {
      seenById.set(item.id, item);
      upsertUnread(item, 'add');
    }
  }
  if (typeof body.unreadCount === 'number') {
    typedEl('unreadCount').textContent = String(body.unreadCount);
  }
}

/**
 * Помечает одно уведомление прочитанным.
 *
 * @param {string} id
 * @returns {Promise<void>}
 */
async function markRead(id) {
  const result = await api(`/api/v1/notifications/${id}/read`, { method: 'PATCH' });
  if (result.status === 200) {
    removeUnread(id);
  }
}

/**
 * Помечает все непрочитанные прочитанными.
 *
 * @returns {Promise<void>}
 */
async function markAllRead() {
  const result = await api('/api/v1/notifications/read-all', { method: 'POST' });
  if (result.status === 200) {
    typedEl('unreadList').innerHTML = '';
    typedEl('unreadCount').textContent = '0';
  }
}

/**
 * Вешает обработчики UI.
 *
 * @returns {void}
 */
function bindUi() {
  typedEl('btnGenerateUser').addEventListener('click', () => {
    typedEl('userId').value = newUuid();
    syncTargetDefault();
  });
  typedEl('userId').addEventListener('change', syncTargetDefault);
  typedEl('btnReady').addEventListener('click', () => {
    void prepareSession();
  });
  typedEl('btnConnect').addEventListener('click', () => {
    if (state.io !== null) {
      connectWs(state.io);
    }
  });
  typedEl('btnDisconnect').addEventListener('click', () => {
    disconnectWs();
  });
  typedEl('typeSelect').addEventListener('change', applySamplePayload);
  typedEl('typeCustom').addEventListener('change', applySamplePayload);
  typedEl('payload').addEventListener('input', () => {
    validatePayload();
  });
  typedEl('btnSend').addEventListener('click', () => {
    void sendBurst();
  });
  typedEl('btnReplayIdem').addEventListener('click', () => {
    void replayIdempotent();
  });
  typedEl('btnRefreshUnread').addEventListener('click', () => {
    void refreshUnread();
  });
  typedEl('btnReadAll').addEventListener('click', () => {
    void markAllRead();
  });
  typedEl('btnClearLog').addEventListener('click', () => {
    typedEl('httpLog').innerHTML = '';
  });
  typedEl('useIdempotency').addEventListener('change', () => {
    if (typedEl('useIdempotency').checked && state.lastIdempotencyKey === null) {
      state.lastIdempotencyKey = newUuid();
    }
    if (!typedEl('useIdempotency').checked) {
      // ключ оставляем — «Повторить» всё ещё может использовать последний
    }
    syncIdemPreview();
  });

  document.querySelectorAll('[data-scenario]').forEach((node) => {
    node.addEventListener('click', () => {
      const id = node.getAttribute('data-scenario');
      if (id !== null) {
        void runScenario(id);
      }
    });
  });
}

/**
 * Точка входа демо-страницы.
 *
 * @returns {Promise<void>}
 */
async function main() {
  fillTypeSelect();
  typedEl('userId').value = newUuid();
  syncTargetDefault();
  applySamplePayload();
  setConnBadge('offline');
  renderStats();
  renderRateLimitTimer();
  syncIdemPreview();
  setScenarioBanner('Нажмите «Подготовиться», затем сценарии A → E.');

  state.io = await loadSocketIo();
  bindUi();
}

void main();
