import type { ColumnType, Generated } from 'kysely';

/**
 * Строка таблицы notifications в терминах Kysely.
 *
 * Зачем: типизирует SELECT/INSERT/UPDATE, не отбирая контроль над реальным SQL — DDL остаётся
 * в миграциях (см. ADR-0001), а не выводится из ORM-моделей.
 * Как: nullable- и optional-колонки описаны через `ColumnType<Select, Insert, Update>` с разными
 * типами на чтение/запись. `created_at` неизменяем после вставки (UpdateType = never) — это
 * отражает инвариант «created_at выводится из UUIDv7» из ADR-0002: менять его нельзя, иначе
 * ломается partition pruning по id.
 */
export interface NotificationsTable {
  id: string;
  user_id: string;
  type: string;
  payload: ColumnType<
    Record<string, unknown>,
    Record<string, unknown> | undefined,
    Record<string, unknown> | undefined
  >;
  dedup_hash: ColumnType<Buffer, Buffer, never>;
  occurrences: Generated<number>;
  created_at: ColumnType<Date, Date, never>;
  last_seen_at: ColumnType<Date, Date, Date>;
  read_at: ColumnType<Date | null, Date | null | undefined, Date | null>;
  delivered_at: ColumnType<Date | null, Date | null | undefined, Date | null>;
}

/**
 * Схема базы данных для Kysely.
 *
 * Зачем: единая точка типов для всех таблиц; расширяется по мере добавления миграций
 * (следующая — `idempotency_keys` в коммите 11).
 * Как: имя ключа совпадает с именем таблицы в PostgreSQL.
 */
export interface Database {
  notifications: NotificationsTable;
}
