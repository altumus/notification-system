import { createHash } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';

import { canonicalJson } from '../../common/utils/canonical-json.js';

import { IdempotencyConflictError, IdempotencyKeyInvalidError } from './idempotency.errors.js';
import {
  IDEMPOTENCY_PENDING_STATUS,
  IdempotencyRepository,
  NOTIFICATIONS_CREATE_SCOPE,
} from './idempotency.repository.js';

/**
 * TTL сохранённых ответов идемпотентности (24 часа).
 */
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Размер чанка очистки просроченных ключей.
 */
const PURGE_CHUNK_SIZE = 500;

/**
 * Максимум чанков за один cron-прогон (защита от долгой блокировки).
 */
const PURGE_MAX_CHUNKS = 20;

/**
 * Допустимый формат Idempotency-Key.
 */
const IDEMPOTENCY_KEY_PATTERN = /^[\w.-]{1,255}$/;

/**
 * Результат begin: либо нужно выполнить handler, либо вернуть replay.
 */
export type IdempotencyBeginResult =
  { kind: 'proceed' } | { kind: 'replay'; status: number; body: Record<string, unknown> };

/**
 * Сервис транспортной идемпотентности create.
 *
 * Зачем: ретрай продюсера не создаёт вторую сущность (см. ADR-0006); это не дедуп R6.
 * Как: claim через INSERT ON CONFLICT; pending → 409 Retry-After; hash mismatch → 409;
 * совпадение → replay с Idempotent-Replay.
 */
@Injectable()
export class IdempotencyService {
  private readonly logger = new Logger(IdempotencyService.name);

  /**
   * Создаёт сервис идемпотентности.
   *
   * @param repository - доступ к idempotency_keys
   */
  public constructor(private readonly repository: IdempotencyRepository) {}

  /**
   * Валидирует ключ и хеширует тело запроса.
   *
   * @param key - заголовок Idempotency-Key
   * @param body - тело create
   * @returns Нормализованный ключ и request_hash
   * @throws {IdempotencyKeyInvalidError} Если ключ пустой/невалидный
   */
  public parseKeyAndHash(
    key: string,
    body: Record<string, unknown>,
  ): { key: string; requestHash: Buffer } {
    const trimmed = key.trim();
    if (!IDEMPOTENCY_KEY_PATTERN.test(trimmed)) {
      throw new IdempotencyKeyInvalidError('Idempotency-Key: 1–255 символов [A-Za-z0-9_.-]');
    }
    const requestHash = createHash('sha256').update(canonicalJson(body)).digest();
    return { key: trimmed, requestHash };
  }

  /**
   * Резервирует ключ или возвращает сохранённый ответ.
   *
   * @param key - нормализованный ключ
   * @param actorId - userId из JWT
   * @param requestHash - sha256 тела
   * @returns proceed | replay
   * @throws {IdempotencyConflictError} In-flight или другой hash
   */
  public async begin(
    key: string,
    actorId: string,
    requestHash: Buffer,
  ): Promise<IdempotencyBeginResult> {
    const expiresAt = new Date(Date.now() + IDEMPOTENCY_TTL_MS);
    const claim = await this.repository.tryClaim({
      key,
      scope: NOTIFICATIONS_CREATE_SCOPE,
      actorId,
      requestHash,
      expiresAt,
    });

    if (claim.kind === 'claimed') {
      return { kind: 'proceed' };
    }

    const { row } = claim;
    if (row.expiresAt.getTime() <= Date.now()) {
      await this.repository.deleteByKey(key);
      return this.begin(key, actorId, requestHash);
    }

    if (!row.requestHash.equals(requestHash)) {
      throw new IdempotencyConflictError('Idempotency-Key уже использован с другим телом запроса');
    }

    if (row.responseStatus === IDEMPOTENCY_PENDING_STATUS) {
      throw new IdempotencyConflictError('Запрос с этим Idempotency-Key ещё выполняется', {
        retryAfterSec: 1,
      });
    }

    return {
      kind: 'replay',
      status: row.responseStatus,
      body: row.responseBody,
    };
  }

  /**
   * Сохраняет успешный/ошибочный ответ после выполнения handler.
   *
   * @param key - ключ
   * @param status - HTTP-статус
   * @param body - JSON-тело
   * @returns void
   */
  public async complete(key: string, status: number, body: Record<string, unknown>): Promise<void> {
    await this.repository.complete(key, status, body);
  }

  /**
   * Освобождает pending-claim после неожиданного сбоя (чтобы ретрай не упёрся в 409).
   *
   * @param key - ключ
   * @returns void
   */
  public async release(key: string): Promise<void> {
    await this.repository.release(key);
  }

  /**
   * Cron: удаляет просроченные ключи чанками.
   *
   * Зачем: таблица не растёт бесконечно при потоке ретраев.
   * Как: до PURGE_MAX_CHUNKS удалений по PURGE_CHUNK_SIZE.
   *
   * @returns void
   */
  @Cron(CronExpression.EVERY_HOUR)
  public async purgeExpired(): Promise<void> {
    let total = 0;
    for (let i = 0; i < PURGE_MAX_CHUNKS; i += 1) {
      const deleted = await this.repository.deleteExpiredChunk(PURGE_CHUNK_SIZE);
      total += deleted;
      if (deleted < PURGE_CHUNK_SIZE) {
        break;
      }
    }
    if (total > 0) {
      this.logger.log({ deleted: total }, 'Очищены просроченные idempotency_keys');
    }
  }
}
