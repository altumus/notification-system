-- Up Migration

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE notifications (
  id           uuid        NOT NULL,                      -- UUIDv7, генерируется приложением
  user_id      uuid        NOT NULL,
  type         varchar(64) NOT NULL,
  payload      jsonb       NOT NULL DEFAULT '{}'::jsonb,
  dedup_hash   bytea       NOT NULL,                      -- sha256(user|type|canonical payload)
  occurrences  integer     NOT NULL DEFAULT 1,            -- сколько дублей схлопнулось
  created_at   timestamptz NOT NULL,                      -- == время из UUIDv7, точность мс
  last_seen_at timestamptz NOT NULL,                      -- время последнего дубля
  read_at      timestamptz,
  delivered_at timestamptz,                               -- NULL = ещё не подтверждено клиентом
  CONSTRAINT notifications_pkey PRIMARY KEY (id, created_at),
  CONSTRAINT notifications_occurrences_positive CHECK (occurrences > 0),
  CONSTRAINT notifications_type_format CHECK (type ~ '^[a-z][a-z0-9_.]{1,63}$'),
  CONSTRAINT notifications_payload_is_object CHECK (jsonb_typeof(payload) = 'object')
) PARTITION BY RANGE (created_at);

-- Список непрочитанных с keyset-пагинацией (R1).
CREATE INDEX notifications_unread_idx
  ON notifications (user_id, created_at DESC, id DESC) WHERE read_at IS NULL;

-- Поиск якоря для схлопывания дублей (R6).
CREATE INDEX notifications_dedup_idx
  ON notifications (user_id, type, dedup_hash, created_at DESC);

-- Подсчёт для rate limit (R5).
CREATE INDEX notifications_ratelimit_idx
  ON notifications (user_id, type, created_at DESC);

-- Догон недоставленного при подключении и sweeper-ом (R9).
CREATE INDEX notifications_undelivered_idx
  ON notifications (user_id, created_at) WHERE delivered_at IS NULL;

-- Создание месячной партиции; идемпотентно.
CREATE OR REPLACE FUNCTION ensure_notifications_partition(p_month date)
RETURNS text LANGUAGE plpgsql AS $$
DECLARE
  v_start date := date_trunc('month', p_month)::date;
  v_end   date := (date_trunc('month', p_month) + interval '1 month')::date;
  v_name  text := format('notifications_%s', to_char(v_start, 'YYYY_MM'));
BEGIN
  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS %I PARTITION OF notifications FOR VALUES FROM (%L) TO (%L)',
    v_name, v_start, v_end);
  RETURN v_name;
END $$;

-- Страховка: строки с неожиданной датой не потеряются и не сломают вставку.
CREATE TABLE IF NOT EXISTS notifications_default PARTITION OF notifications DEFAULT;

-- Партиции на текущий и два следующих месяца.
SELECT ensure_notifications_partition(current_date);
SELECT ensure_notifications_partition((current_date + interval '1 month')::date);
SELECT ensure_notifications_partition((current_date + interval '2 month')::date);

-- Down Migration

DROP FUNCTION IF EXISTS ensure_notifications_partition(date);
DROP TABLE IF EXISTS notifications CASCADE;
