import { Injectable } from '@nestjs/common';
import { sql, type Transaction } from 'kysely';

import type { Database } from '../database/schema.types.js';

import type { NotificationRow } from './domain/notification.mapper.js';

/**
 * Результат захвата advisory-lock и серверного времени.
 */
export interface UserTypeLockResult {
  now: Date;
}

/**
 * Счётчик rate-limit окна.
 */
export interface RateWindowCount {
  used: number;
  oldest: Date | null;
}

/**
 * Поля для INSERT нового уведомления.
 */
export interface InsertNotificationRow {
  id: string;
  userId: string;
  type: string;
  payload: Record<string, unknown>;
  dedupHash: Buffer;
  createdAt: Date;
}

/**
 * SQL-доступ к таблице notifications.
 *
 * Зачем: весь SQL создания сосредоточен здесь — сервис описывает бизнес-порядок,
 * а не тексты запросов (коммит 07 плана).
 * Как: каждый метод принимает активную транзакцию Kysely; параметризованный SQL только.
 */
@Injectable()
export class NotificationsRepository {
  /**
   * Ставит транзакционный advisory-lock на (userId, type) и возвращает clock_timestamp().
   *
   * Зачем: сериализует dedup и rate-limit для одной пары; единый источник времени для UUIDv7.
   * Как: `pg_advisory_xact_lock(hashtextextended(...))` + `clock_timestamp()` в одном SELECT.
   *
   * @param trx - активная транзакция
   * @param userId - получатель
   * @param type - тип уведомления
   * @returns Серверное «сейчас» из БД
   * @throws {Error} Если БД не вернула now
   */
  public async acquireUserTypeLock(
    trx: Transaction<Database>,
    userId: string,
    type: string,
  ): Promise<UserTypeLockResult> {
    const userTypeKey = `${userId}:${type}`;
    const result = await sql<{ now: Date }>`
      select pg_advisory_xact_lock(hashtextextended(${userTypeKey}, 0)), clock_timestamp() as now
    `.execute(trx);
    const now = result.rows[0]?.now;
    if (now === undefined) {
      throw new Error('acquireUserTypeLock: clock_timestamp не вернул значение');
    }
    return { now };
  }

  /**
   * Ищет якорь для схлопывания дублей в фиксированном окне.
   *
   * @param trx - активная транзакция
   * @param userId - получатель
   * @param type - тип
   * @param dedupHash - sha256 payload
   * @param windowStart - нижняя граница created_at (now - dedupWindow)
   * @returns Якорь с FOR UPDATE или null
   */
  public async findDedupAnchor(
    trx: Transaction<Database>,
    userId: string,
    type: string,
    dedupHash: Buffer,
    windowStart: Date,
  ): Promise<NotificationRow | null> {
    const result = await sql<NotificationRow>`
      select id, user_id, type, payload, occurrences, created_at, last_seen_at, read_at, delivered_at
      from notifications
      where user_id = ${userId}::uuid
        and type = ${type}
        and dedup_hash = ${dedupHash}
        and created_at > ${windowStart}
      order by created_at desc
      limit 1
      for update
    `.execute(trx);
    return result.rows[0] ?? null;
  }

  /**
   * Инкрементирует occurrences и обновляет last_seen_at у якоря.
   *
   * @param trx - активная транзакция
   * @param id - id якоря
   * @param createdAt - created_at якоря (для pruning)
   * @param lastSeenAt - новое время последнего дубля
   * @returns Обновлённая строка
   * @throws {Error} Если UPDATE не вернул строку
   */
  public async incrementOccurrences(
    trx: Transaction<Database>,
    id: string,
    createdAt: Date,
    lastSeenAt: Date,
  ): Promise<NotificationRow> {
    const result = await sql<NotificationRow>`
      update notifications
      set occurrences = occurrences + 1,
          last_seen_at = ${lastSeenAt}
      where id = ${id}::uuid and created_at = ${createdAt}
      returning id, user_id, type, payload, occurrences, created_at, last_seen_at, read_at, delivered_at
    `.execute(trx);
    const row = result.rows[0];
    if (row === undefined) {
      throw new Error(`incrementOccurrences: строка ${id} не найдена`);
    }
    return row;
  }

  /**
   * Считает принятые уведомления в окне rate-limit.
   *
   * @param trx - активная транзакция
   * @param userId - получатель
   * @param type - тип
   * @param windowStart - нижняя граница created_at
   * @returns used и oldest created_at в окне
   */
  public async countInRateWindow(
    trx: Transaction<Database>,
    userId: string,
    type: string,
    windowStart: Date,
  ): Promise<RateWindowCount> {
    const result = await sql<{ used: number; oldest: Date | null }>`
      select count(*)::int as used, min(created_at) as oldest
      from notifications
      where user_id = ${userId}::uuid
        and type = ${type}
        and created_at > ${windowStart}
    `.execute(trx);
    return {
      used: result.rows[0]?.used ?? 0,
      oldest: result.rows[0]?.oldest ?? null,
    };
  }

  /**
   * Вставляет новое уведомление.
   *
   * @param trx - активная транзакция
   * @param row - поля для INSERT
   * @returns Вставленная строка
   * @throws {Error} Если INSERT не вернул строку
   */
  public async insert(
    trx: Transaction<Database>,
    row: InsertNotificationRow,
  ): Promise<NotificationRow> {
    const result = await sql<NotificationRow>`
      insert into notifications (id, user_id, type, payload, dedup_hash, created_at, last_seen_at)
      values (
        ${row.id}::uuid,
        ${row.userId}::uuid,
        ${row.type},
        ${JSON.stringify(row.payload)}::jsonb,
        ${row.dedupHash},
        ${row.createdAt},
        ${row.createdAt}
      )
      returning id, user_id, type, payload, occurrences, created_at, last_seen_at, read_at, delivered_at
    `.execute(trx);
    const inserted = result.rows[0];
    if (inserted === undefined) {
      throw new Error('insert: RETURNING пуст');
    }
    return inserted;
  }
}
