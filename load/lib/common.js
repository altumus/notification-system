/**
 * Общие помощники нагрузочных сценариев.
 *
 * Зачем: три профиля делают одно и то же (выбор профиля, uuid, service-токен) — без общего
 * модуля это копипаста, которая расходится при правках. Внешние зависимости намеренно
 * не используются: удалённый импорт с CDN сделал бы каждый прогон и CI зависимым от
 * доступности стороннего хоста.
 */

import { fail } from 'k6';
import http from 'k6/http';

/**
 * Нормализует базовый URL стенда.
 *
 * @param {string | undefined} value - значение BASE_URL из окружения
 * @returns {string} URL без завершающего слэша
 */
export function resolveBaseUrl(value) {
  return (value ?? 'http://localhost:3001').replace(/\/$/, '');
}

/**
 * Выбирает профиль нагрузки по имени с понятной ошибкой.
 *
 * @param {Record<string, object>} profiles - доступные профили
 * @param {string | undefined} name - значение LOAD_PROFILE
 * @returns {object} Настройки выбранного профиля
 */
export function resolveProfile(profiles, name) {
  const key = name ?? 'baseline';
  const profile = profiles[key];
  if (profile === undefined) {
    throw new Error(
      `Неизвестный LOAD_PROFILE=${key}; доступны: ${Object.keys(profiles).join(', ')}`,
    );
  }
  return profile;
}

/**
 * Генерирует UUIDv4 без внешних зависимостей.
 *
 * @returns {string} Случайный UUID
 */
export function uuidv4() {
  const hex = '0123456789abcdef';
  let out = '';
  for (let i = 0; i < 36; i += 1) {
    if (i === 8 || i === 13 || i === 18 || i === 23) {
      out += '-';
    } else if (i === 14) {
      out += '4';
    } else if (i === 19) {
      // Вариант RFC 4122: старшие биты 10xx.
      out += hex[8 + Math.floor(Math.random() * 4)];
    } else {
      out += hex[Math.floor(Math.random() * 16)];
    }
  }
  return out;
}

/**
 * Детерминированный UUID получателя по номеру VU.
 *
 * Зачем: нагрузка должна размазываться по многим userId, иначе advisory-lock на одной
 * паре (user, type) превращает профиль записи в замер сериализации.
 *
 * @param {number} vu - номер виртуального пользователя (__VU)
 * @returns {string} UUID в валидном формате
 */
export function userIdForVu(vu) {
  return `00000000-0000-4000-8000-${String(vu).padStart(12, '0')}`;
}

/**
 * Получает токен на конкретный userId и роль.
 *
 * @param {string} baseUrl - базовый URL стенда
 * @param {string} userId - субъект токена
 * @param {'user' | 'service'} role - роль актора
 * @returns {string} JWT
 */
export function issueToken(baseUrl, userId, role) {
  const res = http.post(`${baseUrl}/api/v1/auth/dev-token`, JSON.stringify({ userId, role }), {
    headers: { 'content-type': 'application/json' },
  });
  if (res.status !== 201) {
    fail(`dev-token → ${res.status} (нужен AUTH_DEV_TOKENS_ENABLED=true на стенде)`);
  }
  return res.json('token');
}

/**
 * Получает service-токен: он может создавать уведомления любому userId.
 *
 * @param {string} baseUrl - базовый URL стенда
 * @returns {string} JWT
 */
export function issueServiceToken(baseUrl) {
  return issueToken(baseUrl, uuidv4(), 'service');
}

/**
 * Заголовки авторизованного JSON-запроса.
 *
 * @param {string} token - JWT
 * @returns {Record<string, string>} Заголовки
 */
export function jsonAuthHeaders(token) {
  return { 'content-type': 'application/json', authorization: `Bearer ${token}` };
}

/**
 * Типы уведомлений из демо-реестра и поле, по которому для них считается дедуп.
 *
 * Зачем: у части типов в `NotificationTypeConfig` задан `dedupKeys`, и хеш дедупа считается
 * только по этим полям. Если их не передать, у всех запросов такого типа хеш совпадёт и
 * нагрузка схлопнется в один UPDATE вместо вставок — профиль записи начнёт мерить не то.
 */
export const NOTIFICATION_TYPES = [
  { type: 'chat.message', dedupKey: undefined },
  { type: 'order.status_changed', dedupKey: 'orderId' },
  { type: 'payment.failed', dedupKey: 'paymentId' },
  { type: 'friend.request', dedupKey: 'fromUserId' },
];

/**
 * Собирает payload, гарантированно уникальный с точки зрения дедупа.
 *
 * @param {{ type: string, dedupKey: string | undefined }} spec - тип из NOTIFICATION_TYPES
 * @param {string} uniqueSuffix - уникальная часть в пределах пользователя и типа
 * @returns {Record<string, unknown>} payload для POST /notifications
 */
export function buildUniquePayload(spec, uniqueSuffix) {
  if (spec.dedupKey === undefined) {
    return { text: `msg-${uniqueSuffix}` };
  }
  // Для типов с dedupKeys уникальным обязано быть именно это поле — остальные в хеш не входят.
  return { [spec.dedupKey]: `${spec.dedupKey}-${uniqueSuffix}`, note: `n-${uniqueSuffix}` };
}
