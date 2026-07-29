/**
 * Профиль худшего случая: вся нагрузка в одну пару (userId, type).
 *
 * Зачем: создание берёт `pg_advisory_xact_lock(hash(userId:type))`, поэтому запросы к одной
 * паре сериализуются. ADR-0004 называет это узким местом при тысячах RPS на пару — сценарий
 * измеряет, где именно граница, чтобы решение о переносе счётчика в Redis опиралось на числа.
 *
 * Ожидаемая картина: после первых 10 запросов почти всё отвечает 429 (лимит окна исчерпан),
 * а латентность растёт вместе с rate — это и есть предмет измерения, а не ошибка. Порог
 * держим по отсутствию 5xx и по тому, что сервис продолжает отвечать штатными кодами.
 *
 * Usage:
 *   k6 run load/hot-pair.js
 *   k6 run -e LOAD_PROFILE=stress load/hot-pair.js
 */

import { check } from 'k6';
import http from 'k6/http';
import { Trend } from 'k6/metrics';

import {
  issueServiceToken,
  jsonAuthHeaders,
  resolveBaseUrl,
  resolveProfile,
  uuidv4,
} from './lib/common.js';

const BASE_URL = resolveBaseUrl(__ENV.BASE_URL);

const profile = resolveProfile(
  {
    baseline: { rate: 20, duration: '30s', vus: 30 },
    peak: { rate: 100, duration: '1m', vus: 150 },
    stress: { rate: 500, duration: '1m', vus: 400 },
    ci: { rate: 20, duration: '20s', vus: 30 },
  },
  __ENV.LOAD_PROFILE,
);

const hotPairDuration = new Trend('hot_pair_duration', true);

export const options = {
  scenarios: {
    hotPair: {
      executor: 'constant-arrival-rate',
      rate: profile.rate,
      timeUnit: '1s',
      duration: profile.duration,
      preAllocatedVUs: profile.vus,
      maxVUs: profile.vus * 2,
    },
  },
  thresholds: {
    // Главное: под сериализацией сервис отвечает штатными кодами, а не 5xx и не таймаутами.
    http_req_failed: ['rate<0.01'],
    hot_pair_duration: ['p(99)<2000'],
  },
};

/**
 * Готовит одного пользователя и один тип — намеренно горячую пару.
 *
 * @returns {{ token: string, userId: string }} Данные для сценария
 */
export function setup() {
  return { token: issueServiceToken(BASE_URL), userId: uuidv4() };
}

/**
 * Пишет в одну и ту же пару (userId, type).
 *
 * @param {{ token: string, userId: string }} data - результат setup
 * @returns {void}
 */
export default function hotPair(data) {
  const res = http.post(
    `${BASE_URL}/api/v1/notifications`,
    JSON.stringify({
      userId: data.userId,
      type: 'chat.message',
      payload: { seq: __ITER, vu: __VU },
    }),
    {
      headers: jsonAuthHeaders(data.token),
      tags: { name: 'POST /notifications (hot pair)' },
      responseCallback: http.expectedStatuses(200, 201, 429),
    },
  );

  hotPairDuration.add(res.timings.duration);
  check(res, {
    'нет 5xx под сериализацией': (r) => r.status < 500,
    'ответ штатным кодом': (r) => r.status === 201 || r.status === 200 || r.status === 429,
  });
}
