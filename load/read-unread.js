/**
 * Нагрузочный профиль чтения: список непрочитанных и счётчик бейджа.
 *
 * Зачем: в реальном трафике чтений на порядок больше, чем записей — бейдж и список дёргает
 * каждая открытая вкладка. Проверяем, что keyset-пагинация и частичный индекс
 * `notifications_unread_idx` держат нагрузку на пользователе с непустым списком.
 *
 * Как: setup наполняет одного пользователя уведомлениями (лимит 10/мин на type, поэтому
 * набираем несколькими типами), затем читаем в constant-arrival-rate.
 *
 * Usage:
 *   k6 run load/read-unread.js
 *   k6 run -e LOAD_PROFILE=peak load/read-unread.js
 */

import { check, fail } from 'k6';
import http from 'k6/http';

import {
  buildUniquePayload,
  issueServiceToken,
  jsonAuthHeaders,
  NOTIFICATION_TYPES,
  resolveBaseUrl,
  resolveProfile,
  uuidv4,
} from './lib/common.js';

const BASE_URL = resolveBaseUrl(__ENV.BASE_URL);

/** Сколько уведомлений создаём на каждый тип (ровно лимит окна 10/мин). */
const SEED_PER_TYPE = 10;

const profile = resolveProfile(
  {
    baseline: { rate: 50, duration: '1m', vus: 50 },
    peak: { rate: 300, duration: '2m', vus: 200 },
    stress: { rate: 1000, duration: '2m', vus: 600 },
    ci: { rate: 50, duration: '30s', vus: 50 },
  },
  __ENV.LOAD_PROFILE,
);

export const options = {
  scenarios: {
    read: {
      executor: 'constant-arrival-rate',
      rate: profile.rate,
      timeUnit: '1s',
      duration: profile.duration,
      preAllocatedVUs: profile.vus,
      maxVUs: profile.vus * 2,
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    // Чтение идёт по частичному индексу без транзакции — ожидания строже, чем на записи.
    http_req_duration: ['p(95)<100', 'p(99)<250'],
  },
};

/**
 * Создаёт пользователя с непрочитанными уведомлениями.
 *
 * @returns {{ token: string, userId: string }} Данные для сценария
 */
export function setup() {
  const token = issueServiceToken(BASE_URL);
  const userId = uuidv4();
  const headers = jsonAuthHeaders(token);

  let seeded = 0;
  for (const spec of NOTIFICATION_TYPES) {
    for (let i = 0; i < SEED_PER_TYPE; i += 1) {
      const res = http.post(
        `${BASE_URL}/api/v1/notifications`,
        JSON.stringify({
          userId,
          type: spec.type,
          payload: buildUniquePayload(spec, `seed-${i}`),
        }),
        { headers, responseCallback: http.expectedStatuses(200, 201, 429) },
      );
      if (res.status === 201) {
        seeded += 1;
      }
    }
  }
  if (seeded === 0) {
    fail('Не удалось создать ни одного уведомления для чтения');
  }
  return { token, userId, seeded };
}

/**
 * Читает список непрочитанных и счётчик.
 *
 * @param {{ token: string }} data - результат setup
 * @returns {void}
 */
export default function readUnread(data) {
  const headers = { authorization: `Bearer ${data.token}` };

  const list = http.get(`${BASE_URL}/api/v1/notifications/unread?limit=20`, {
    headers,
    tags: { name: 'GET /notifications/unread' },
  });
  check(list, {
    'unread → 200': (r) => r.status === 200,
    'unread отдаёт items': (r) => Array.isArray(r.json('items')),
  });

  const count = http.get(`${BASE_URL}/api/v1/notifications/unread/count`, {
    headers,
    tags: { name: 'GET /notifications/unread/count' },
  });
  check(count, { 'count → 200': (r) => r.status === 200 });
}
