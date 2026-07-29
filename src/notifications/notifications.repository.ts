import { Injectable } from '@nestjs/common';
import { sql, type Kysely, type Transaction } from 'kysely';

import type { Database } from '../database/schema.types.js';

import type { NotificationRow } from './domain/notification.mapper.js';

/** Исполнитель SQL: корневой Kysely или транзакция. */
type DbExecutor = Kysely<Database> | Transaction<Database>;

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
    const result = await sql<{ used: string; oldest: Date | null }>`
      select count(*)::text as used, min(created_at) as oldest
      from notifications
      where user_id = ${userId}::uuid
        and type = ${type}
        and created_at > ${windowStart}
    `.execute(trx);
    return {
      used: Number(result.rows[0]?.used ?? '0'),
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

  /**
   * Помечает уведомление прочитанным, если оно ещё непрочитано.
   *
   * @param db - подключение или транзакция
   * @param userId - владелец
   * @param id - id уведомления
   * @param createdAt - created_at из UUIDv7 (partition pruning)
   * @returns Обновлённая строка или null, если UPDATE не затронул строк
   */
  public async markAsReadIfUnread(
    db: DbExecutor,
    userId: string,
    id: string,
    createdAt: Date,
  ): Promise<NotificationRow | null> {
    const result = await sql<NotificationRow>`
      update notifications
      set read_at = clock_timestamp()
      where id = ${id}::uuid
        and created_at = ${createdAt}
        and user_id = ${userId}::uuid
        and read_at is null
      returning id, user_id, type, payload, occurrences, created_at, last_seen_at, read_at, delivered_at
    `.execute(db);
    return result.rows[0] ?? null;
  }

  /**
   * Загружает уведомление по составному ключу и владельцу.
   *
   * @param db - подключение или транзакция
   * @param userId - ожидаемый владелец
   * @param id - id
   * @param createdAt - created_at из UUIDv7
   * @returns Строка или null
   */
  public async findByIdForUser(
    db: DbExecutor,
    userId: string,
    id: string,
    createdAt: Date,
  ): Promise<NotificationRow | null> {
    const result = await sql<NotificationRow>`
      select id, user_id, type, payload, occurrences, created_at, last_seen_at, read_at, delivered_at
      from notifications
      where id = ${id}::uuid
        and created_at = ${createdAt}
        and user_id = ${userId}::uuid
      limit 1
    `.execute(db);
    return result.rows[0] ?? null;
  }

  /**
   * Помечает пачку непрочитанных прочитанными (чанк).
   *
   * @param db - подключение
   * @param userId - владелец
   * @param retentionStart - нижняя граница created_at (окно retention)
   * @param chunkSize - максимум строк за один UPDATE
   * @returns Число обновлённых строк
   */
  public async markAllAsReadChunk(
    db: DbExecutor,
    userId: string,
    retentionStart: Date,
    chunkSize: number,
  ): Promise<number> {
    const result = await sql<{ id: string }>`
      update notifications
      set read_at = clock_timestamp()
      where ctid in (
        select ctid from notifications
        where user_id = ${userId}::uuid
          and read_at is null
          and created_at > ${retentionStart}
        limit ${chunkSize}
      )
      returning id
    `.execute(db);
    return result.rows.length;
  }

  /**
   * Keyset-выборка непрочитанных (limit+1 для nextCursor).
   *
   * Зачем: OFFSET на больших объёмах деградирует и пропускает строки при вставках.
   * Как: `(created_at, id) < (cursor)` в порядке DESC.
   *
   * @param db - подключение
   * @param userId - владелец
   * @param limit - размер страницы
   * @param cursor - опциональная позиция
   * @returns Строки (может быть limit+1)
   */
  public async listUnread(
    db: DbExecutor,
    userId: string,
    limit: number,
    cursor: { createdAt: Date; id: string } | undefined,
  ): Promise<NotificationRow[]> {
    const fetchLimit = limit + 1;
    if (cursor === undefined) {
      const result = await sql<NotificationRow>`
        select id, user_id, type, payload, occurrences, created_at, last_seen_at, read_at, delivered_at
        from notifications
        where user_id = ${userId}::uuid and read_at is null
        order by created_at desc, id desc
        limit ${fetchLimit}
      `.execute(db);
      return result.rows;
    }
    const result = await sql<NotificationRow>`
      select id, user_id, type, payload, occurrences, created_at, last_seen_at, read_at, delivered_at
      from notifications
      where user_id = ${userId}::uuid
        and read_at is null
        and (
          created_at < ${cursor.createdAt}
          or (created_at = ${cursor.createdAt} and id < ${cursor.id}::uuid)
        )
      order by created_at desc, id desc
      limit ${fetchLimit}
    `.execute(db);
    return result.rows;
  }

  /**
   * Считает непрочитанные с верхней границей (для бейджа «N+»).
   *
   * @param db - подключение
   * @param userId - владелец
   * @param cap - максимум точного подсчёта
   * @returns count (не больше cap) и exact
   */
  public async countUnread(
    db: DbExecutor,
    userId: string,
    cap: number,
  ): Promise<{ count: number; exact: boolean }> {
    const result = await sql<{ n: number }>`
      select count(*)::int as n from (
        select 1 from notifications
        where user_id = ${userId}::uuid and read_at is null
        limit ${cap + 1}
      ) t
    `.execute(db);
    const n = result.rows[0]?.n ?? 0;
    // Запросили cap+1: если вернулось больше cap — точный count неизвестен (бейдж «N+»).
    if (n > cap) {
      return { count: cap, exact: false };
    }
    return { count: n, exact: true };
  }
}
