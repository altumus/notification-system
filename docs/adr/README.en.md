# Architecture Decision Records

**Язык / Language:** [Русский](./README.md) · English

Accepted architectural decisions. Each ADR answers _why_, not _how_.

| #    | File                                                                              | Decision                                       |
| ---- | --------------------------------------------------------------------------------- | ---------------------------------------------- |
| 0001 | [0001-kysely-vs-orm.md](./en/0001-kysely-vs-orm.md)                               | Kysely + SQL migrations instead of an ORM      |
| 0002 | [0002-partitioning-and-uuidv7.md](./en/0002-partitioning-and-uuidv7.md)           | Monthly partitions + UUIDv7 as PK              |
| 0003 | [0003-dedup-window-semantics.md](./en/0003-dedup-window-semantics.md)             | Fixed dedup window from the anchor             |
| 0004 | [0004-rate-limit-in-postgres.md](./en/0004-rate-limit-in-postgres.md)             | Rate limit in Postgres in the same transaction |
| 0005 | [0005-retention.md](./en/0005-retention.md)                                       | Retention via `DROP PARTITION`, off by default |
| 0006 | [0006-idempotency-vs-dedup.md](./en/0006-idempotency-vs-dedup.md)                 | Idempotency-Key separate from business dedup   |
| 0007 | [0007-railway-instead-of-vps-caddy.md](./en/0007-railway-instead-of-vps-caddy.md) | Railway instead of VPS + Caddy for the stand   |

← [Documentation](../README.en.md) · [Project README](../../README.en.md)
