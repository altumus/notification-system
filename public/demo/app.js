/**
 * Клиент демо-страницы Notification System.
 *
 * Зачем: за минуту показать R5/R6/R7/R8/R9 без Postman.
 * Как: REST + Socket.IO; дедуп событий по id (Map); ack на live/backlog.
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
 * Пишет строку в HTTP-лог с подсветкой кода.
 *
 * @param {number} status
 * @param {string} method
 * @param {string} path
 * @param {unknown} body
 * @returns {void}
 */
function logHttp(status, method, path, body) {
  const list = typedEl('httpLog');
  const item = document.createElement('li');
  const bucket =
    status === 201 || status === 200
      ? `code-${String(status)}`
      : status === 429
        ? 'code-429'
        : status >= 400
          ? status >= 500
            ? 'code-5xx'
            : 'code-4xx'
          : '';
  item.className = bucket;
  item.textContent = `${method} ${path} → ${String(status)}\n${JSON.stringify(body, null, 2)}`;
  list.prepend(item);
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
 * Ставит badge состояния WS.
 *
 * @param {'connected' | 'reconnecting' | 'offline'} status
 * @returns {void}
 */
function setConnBadge(status) {
  const badge = typedEl('connBadge');
  badge.className = `badge ${status}`;
  badge.textContent = status;
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
 * @returns {Promise<void>}
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
  logHttp(res.status, 'POST', '/api/v1/auth/dev-token', body);
  if (!res.ok) {
    typedEl('tokenStatus').textContent = 'ошибка токена';
    return;
  }
  state.token = body.token;
  typedEl('tokenStatus').textContent = `ok · ${userId.slice(0, 8)}…`;
}

/**
 * Общий fetch к API с Bearer.
 *
 * @param {string} path
 * @param {RequestInit & { headers?: Record<string, string> }} init
 * @returns {Promise<{ status: number; body: unknown }>}
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
  let body = text;
  try {
    body = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    // оставляем text
  }
  logHttp(res.status, init.method ?? 'GET', path, body);
  return { status: res.status, body };
}

/**
 * Создаёт одно уведомление (с опциональным Idempotency-Key).
 *
 * @param {object} body
 * @param {string | undefined} idempotencyKey
 * @returns {Promise<{ status: number; body: any }>}
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
    const id = result.body.notification?.id;
    if (typeof id === 'string') {
      upsertUnread(result.body.notification, 'dedup');
    }
  } else if (result.status === 429) {
    state.stats.limited += 1;
  } else if (result.status === 201) {
    // live/backlog придёт по WS
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
  }

  for (let i = 0; i < count; i += 1) {
    // Для демонстрации лимита меняем text у chat.message, иначе схлопнется в один.
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
    // Повтор (sweeper/backlog) — обновим occurrences, не дублируем ленту как новое.
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
 * @param {typeof import('socket.io-client').io} io
 * @returns {void}
 */
function bindUi(io) {
  typedEl('btnGenerateUser').addEventListener('click', () => {
    typedEl('userId').value = newUuid();
    syncTargetDefault();
  });
  typedEl('userId').addEventListener('change', syncTargetDefault);
  typedEl('btnToken').addEventListener('click', () => {
    void issueToken();
  });
  typedEl('btnConnect').addEventListener('click', () => {
    connectWs(io);
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

  const io = await loadSocketIo();
  bindUi(io);
}

void main();
