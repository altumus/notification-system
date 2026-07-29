/**
 * Нагрузочный профиль записи: создание уведомлений через REST.
 *
 * Зачем: требование «выдерживать 500k уведомлений/сутки» нужно измерять, а не только считать
 * на бумаге. 500 000 / 86 400 ≈ 5.8 rps в среднем; пики берём с запасом ×10 и ×50, потому что
 * реальный трафик неравномерен (рассылки, утренние пики).
 *
 * Как: k6 constant-arrival-rate — фиксируем RPS независимо от времени ответа, иначе при
 * деградации нагрузка сама себя снижает и график врёт. Каждый VU пишет своему userId,
 * чтобы не превращать тест в замер одной горячей пары (user, type) — для этого есть
 * отдельный сценарий load/hot-pair.js.
 *
 * Профили (LOAD_PROFILE):
 *   baseline — 6 rps, средняя суточная нагрузка при 500k/сутки
 *   peak     — 60 rps, ×10 к средней
 *   stress   — 300 rps, ×50: ищем, где начинается деградация
 *   ci       — 20 rps, 30 секунд: быстрая проверка в пайплайне
 *
 * Usage:
 *   k6 run load/create-notifications.js
 *   k6 run -e LOAD_PROFILE=peak -e BASE_URL=http://localhost:3001 load/create-notifications.js
 */

import { check } from 'k6';
import http from 'k6/http';
import { Counter, Rate } from 'k6/metrics';

import {
  buildUniquePayload,
  issueServiceToken,
  jsonAuthHeaders,
  NOTIFICATION_TYPES,
  resolveBaseUrl,
  resolveProfile,
  userIdForVu,
} from './lib/common.js';

const BASE_URL = resolveBaseUrl(__ENV.BASE_URL);

const profile = resolveProfile(
  {
    baseline: { rate: 6, duration: '1m', vus: 20 },
    peak: { rate: 60, duration: '2m', vus: 120 },
    stress: { rate: 300, duration: '2m', vus: 500 },
    ci: { rate: 20, duration: '30s', vus: 40 },
  },
  __ENV.LOAD_PROFILE,
);

const created = new Counter('notifications_created');
const deduplicated = new Counter('notifications_deduplicated');
const rateLimited = new Counter('notifications_rate_limited');
const acceptedRate = new Rate('notifications_accepted');

export const options = {
  scenarios: {
    create: {
      executor: 'constant-arrival-rate',
      rate: profile.rate,
      timeUnit: '1s',
      duration: profile.duration,
      preAllocatedVUs: profile.vus,
      maxVUs: profile.vus * 2,
    },
  },
  thresholds: {
    // 429 помечен ожидаемым статусом ниже, поэтому в http_req_failed попадают только сбои.
    http_req_failed: ['rate<0.01'],
    // Создание идёт в транзакции с advisory-lock: 200 мс p95 — рабочая цель.
    http_req_duration: ['p(95)<200', 'p(99)<500'],
    notifications_accepted: ['rate>0.95'],
  },
};

/**
 * Готовит service-токен: он один на весь прогон и может писать любому userId.
 *
 * @returns {{ token: string }} Данные для сценария
 */
export function setup() {
  return { token: issueServiceToken(BASE_URL) };
}

/**
 * Один запрос создания уведомления.
 *
 * @param {{ token: string }} data - результат setup
 * @returns {void}
 */
export default function createNotification(data) {
  const userId = userIdForVu(__VU);
  const spec = NOTIFICATION_TYPES[__ITER % NOTIFICATION_TYPES.length];

  const res = http.post(
    `${BASE_URL}/api/v1/notifications`,
    // Payload уникален с точки зрения dedupKeys — иначе мерили бы UPDATE вместо вставки.
    JSON.stringify({
      userId,
      type: spec.type,
      payload: buildUniquePayload(spec, `${__VU}-${__ITER}`),
    }),
    {
      headers: jsonAuthHeaders(data.token),
      tags: { name: 'POST /notifications' },
      // 429 ожидаем: это работающий rate limit, а не сбой сервиса.
      responseCallback: http.expectedStatuses(200, 201, 429),
    },
  );

  if (res.status === 201) {
    created.add(1);
  } else if (res.status === 200) {
    deduplicated.add(1);
  } else if (res.status === 429) {
    rateLimited.add(1);
  }

  acceptedRate.add(res.status === 201 || res.status === 200 || res.status === 429);
  check(res, {
    'нет 5xx': (r) => r.status < 500,
    'нет 401/403': (r) => r.status !== 401 && r.status !== 403,
  });
}
