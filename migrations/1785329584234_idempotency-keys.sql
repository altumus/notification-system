-- Up Migration

-- Транспортная идемпотентность create: не путать с бизнес-дедупом по dedup_hash.
CREATE TABLE idempotency_keys (
  key             text        PRIMARY KEY,
  scope           varchar(64) NOT NULL,
  actor_id        uuid        NOT NULL,
  request_hash    bytea       NOT NULL,
  response_status smallint    NOT NULL,
  response_body   jsonb       NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL
);

CREATE INDEX idempotency_keys_expires_at_idx ON idempotency_keys (expires_at);

-- Down Migration

DROP TABLE IF EXISTS idempotency_keys;
