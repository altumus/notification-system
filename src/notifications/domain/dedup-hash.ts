import { createHash } from 'node:crypto';

import { canonicalJson } from '../../common/utils/canonical-json.js';

/**
 * Входные данные для построения dedup_hash.
 */
export interface BuildDedupHashInput {
  userId: string;
  type: string;
  payload: Record<string, unknown>;
  dedupKeys?: readonly string[];
}

/**
 * Строит sha256-хеш для схлопывания дублей уведомлений.
 *
 * Зачем: R6 — дубли за окно схлопываются в одно; хеш должен быть стабилен при разном
 * порядке ключей JSON и учитывать только релевантные поля (`dedupKeys`).
 * Как: `sha256(userId | type | canonicalJson(slice))`, где slice — весь payload либо
 * подмножество по `dedupKeys`. Разделитель `|` исключает склейку границ полей.
 *
 * @param input - userId, type, payload и опциональные dedupKeys
 * @returns Buffer длиной 32 байта (sha256)
 */
export function buildDedupHash(input: BuildDedupHashInput): Buffer {
  const material = selectDedupMaterial(input.payload, input.dedupKeys);
  const canonical = canonicalJson(material);
  return createHash('sha256').update(`${input.userId}|${input.type}|${canonical}`).digest();
}

/**
 * Выбирает часть payload, участвующую в хеше.
 *
 * @param payload - полный payload уведомления
 * @param dedupKeys - если задан — только эти поля; иначе весь объект
 * @returns Объект для канонической сериализации
 */
function selectDedupMaterial(
  payload: Record<string, unknown>,
  dedupKeys: readonly string[] | undefined,
): Record<string, unknown> {
  if (dedupKeys === undefined || dedupKeys.length === 0) {
    return payload;
  }
  const selected: Record<string, unknown> = {};
  for (const key of dedupKeys) {
    if (Object.hasOwn(payload, key)) {
      selected[key] = payload[key];
    }
  }
  return selected;
}
