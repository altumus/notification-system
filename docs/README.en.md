# Documentation

**Язык / Language:** [Русский](./README.md) · English

## Guides

| Document                         | Description                  |
| -------------------------------- | ---------------------------- |
| [API](./en/api.md)               | REST and WebSocket contracts |
| [Demo](./en/demo.md)             | `/demo` test page scenarios  |
| [Deployment](./en/deployment.md) | Local and Railway            |

## Architecture Decision Records

Why we chose these approaches — see [adr/](./adr/README.en.md).

| ADR                                                   | Topic                        |
| ----------------------------------------------------- | ---------------------------- |
| [0001](./adr/en/0001-kysely-vs-orm.md)                | Kysely instead of an ORM     |
| [0002](./adr/en/0002-partitioning-and-uuidv7.md)      | Partitions + UUIDv7          |
| [0003](./adr/en/0003-dedup-window-semantics.md)       | Dedup window semantics       |
| [0004](./adr/en/0004-rate-limit-in-postgres.md)       | Rate limit in Postgres       |
| [0005](./adr/en/0005-retention.md)                    | Retention via DROP PARTITION |
| [0006](./adr/en/0006-idempotency-vs-dedup.md)         | Idempotency ≠ dedup          |
| [0007](./adr/en/0007-railway-instead-of-vps-caddy.md) | Railway instead of VPS+Caddy |

## Repository root

- [README.en.md](../README.en.md) — quick start and live stand
- [PLAN.md](../PLAN.md) — implementation plan (Russian)
