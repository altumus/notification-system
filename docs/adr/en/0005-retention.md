# ADR-0005: Retention via DROP PARTITION, disabled by default

**Язык / Language:** [Русский](../0005-retention.md) · English

← [All ADRs](../README.en.md)

## Context

At 500k notifications/day (~250 MB/day, ~90 GB/year) storage cannot grow forever. Deleting
data is irreversible: enabling retention by default on first deploy is risky if backups are not
ready or `RETENTION_MONTHS` is misunderstood.

## Decision

- Partitions are monthly (ADR-0002); `RetentionService` drops partitions older than
  `RETENTION_MONTHS` via `DROP TABLE IF EXISTS` **only when** `RETENTION_ENABLED=true`.
  Default is `false`, and startup logs state that retention is off.
- Only partition names matching `^notifications_\d{4}_\d{2}$` may be dropped (allow-list
  before string interpolation into DDL).
- Parallel runs across instances use `pg_try_advisory_xact_lock` — failed lock → quiet exit.
  Transactional locks release automatically on `COMMIT`/`ROLLBACK` (pool-safe).

## Why `DROP TABLE`, not `DELETE`

- Mass `DELETE` holds locks and leaves dead tuples needing `VACUUM`.
- `DROP TABLE` of a partition is a catalog operation (milliseconds) and frees disk immediately.
- Partitioning introduced for 500k/day (ADR-0002) makes retention nearly free.

## Alternatives

- **Retention on by default** — rejected: operators must opt in after backups are ready.
- **Batched `DELETE`** — more flexible but expensive; kept for other ops, not retention.
- **External host cron** — rejected: logic belongs with advisory locks and app config next to
  `PartitionMaintenanceService`.

## Consequences

**Pros:** cheap, predictable deletes; explicit log of retention mode; name allow-list prevents
dropping arbitrary tables.

**Cons:** delete granularity is one month; mistaken enablement is only mitigated by backups and
verified restore.

## Revisit trigger

If some data must live longer than the rest (by type or user) — need finer granularity than
dropping a whole monthly partition (composite partitioning or an archive store).
