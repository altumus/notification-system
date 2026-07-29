import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';

import { KyselyService } from '../../database/kysely.service.js';

/**
 * Статус «ответ ещё не записан» в idempotency_keys.response_status.
 */
export const IDEMPOTENCY_PENDING_STATUS = 0;

/**
 * Scope ключей для создания уведомлений.
 */
export const NOTIFICATIONS_CREATE_SCOPE = 'notifications.create';

/**
 * Строка idempotency_keys, нужная для claim/replay.
 */
export interface IdempotencyRow {
  key: string;
  scope: string;
  actorId: string;
  requestHash: Buffer;
  responseStatus: number;
  responseBody: Record<string, unknown>;
  expiresAt: Date;
}

/**
 * Входные данные для атомарного claim ключа.
 */
export interface IdempotencyClaimInput {
  key: string;
  scope: string;
  actorId: string;
  requestHash: Buffer;
  expiresAt: Date;
}

/**
 * Репозиторий таблицы idempotency_keys.
 *
 * Зачем: атомарный claim через INSERT ON CONFLICT DO NOTHING без блокирующего ожидания.
 * Как: pending-строка (status=0), затем UPDATE ответа; expired чистится cron-ом чанками.
 */
@Injectable()
export class IdempotencyRepository {
  /**
   * Создаёт репозиторий.
   *
   * @param kysely - доступ к БД
   */
  public constructor(private readonly kysely: KyselyService) {}

  /**
   * Пытается зарезервировать ключ (pending). При конфликте возвращает существующую строку.
   *
   * @param input - ключ, scope, actor, hash и expiresAt
   * @returns 'claimed' если вставка прошла, иначе существующая строка
   */
  public async tryClaim(
    input: IdempotencyClaimInput,
  ): Promise<{ kind: 'claimed' } | { kind: 'exists'; row: IdempotencyRow }> {
    const inserted = await this.kysely.db
      .insertInto('idempotency_keys')
      .values({
        key: input.key,
        scope: input.scope,
        actor_id: input.actorId,
        request_hash: input.requestHash,
        response_status: IDEMPOTENCY_PENDING_STATUS,
        response_body: {},
        expires_at: input.expiresAt,
      })
      .onConflict((oc) => oc.column('key').doNothing())
      .returning(['key'])
      .executeTakeFirst();

    if (inserted !== undefined) {
      return { kind: 'claimed' };
    }

    const row = await this.findByKey(input.key);
    if (row !== undefined) {
      return { kind: 'exists', row };
    }

    // Редкая гонка с purge: повторная вставка без рекурсии.
    const insertedAgain = await this.kysely.db
      .insertInto('idempotency_keys')
      .values({
        key: input.key,
        scope: input.scope,
        actor_id: input.actorId,
        request_hash: input.requestHash,
        response_status: IDEMPOTENCY_PENDING_STATUS,
        response_body: {},
        expires_at: input.expiresAt,
      })
      .onConflict((oc) => oc.column('key').doNothing())
      .returning(['key'])
      .executeTakeFirst();

    if (insertedAgain !== undefined) {
      return { kind: 'claimed' };
    }

    const rowAgain = await this.findByKey(input.key);
    if (rowAgain === undefined) {
      throw new Error(`Не удалось зарезервировать Idempotency-Key ${input.key}`);
    }
    return { kind: 'exists', row: rowAgain };
  }

  /**
   * Читает строку по ключу.
   *
   * @param key - Idempotency-Key
   * @returns Строка или undefined
   */
  public async findByKey(key: string): Promise<IdempotencyRow | undefined> {
    const row = await this.kysely.db
      .selectFrom('idempotency_keys')
      .select([
        'key',
        'scope',
        'actor_id',
        'request_hash',
        'response_status',
        'response_body',
        'expires_at',
      ])
      .where('key', '=', key)
      .executeTakeFirst();

    if (row === undefined) {
      return undefined;
    }
    return {
      key: row.key,
      scope: row.scope,
      actorId: row.actor_id,
      requestHash: row.request_hash,
      responseStatus: row.response_status,
      responseBody: row.response_body,
      expiresAt: row.expires_at,
    };
  }

  /**
   * Записывает финальный HTTP-ответ для ранее claimed ключа.
   *
   * @param key - ключ
   * @param responseStatus - HTTP-статус
   * @param responseBody - JSON-тело
   * @returns void
   */
  public async complete(
    key: string,
    responseStatus: number,
    responseBody: Record<string, unknown>,
  ): Promise<void> {
    await this.kysely.db
      .updateTable('idempotency_keys')
      .set({
        response_status: responseStatus,
        response_body: responseBody,
      })
      .where('key', '=', key)
      .execute();
  }

  /**
   * Снимает pending-claim (чтобы ретрай мог начать заново после сбоя).
   *
   * @param key - ключ
   * @returns void
   */
  public async release(key: string): Promise<void> {
    await this.kysely.db
      .deleteFrom('idempotency_keys')
      .where('key', '=', key)
      .where('response_status', '=', IDEMPOTENCY_PENDING_STATUS)
      .execute();
  }

  /**
   * Удаляет ключ независимо от статуса (например, просроченный).
   *
   * @param key - ключ
   * @returns void
   */
  public async deleteByKey(key: string): Promise<void> {
    await this.kysely.db.deleteFrom('idempotency_keys').where('key', '=', key).execute();
  }

  /**
   * Удаляет просроченные ключи чанками.
   *
   * @param limit - размер чанка
   * @returns Число удалённых строк
   */
  public async deleteExpiredChunk(limit: number): Promise<number> {
    const result = await sql`
      delete from idempotency_keys
      where key in (
        select key from idempotency_keys
        where expires_at < now()
        order by expires_at
        limit ${limit}
      )
    `.execute(this.kysely.db);
    return Number(result.numAffectedRows ?? 0);
  }
}
