# Documentation

**Язык / Language:** [Русский](./README.md) · English

## Guides

| Document                           | Description                      |
| ---------------------------------- | -------------------------------- |
| [API](./en/api.md)                 | REST and WebSocket contracts     |
| [Demo](./en/demo.md)               | `/demo` test page scenarios      |
| [Deployment](./en/deployment.md)   | Local and Railway                |
| [Performance](./en/performance.md) | k6 load profiles and p95 targets |

## Requirements and where they are covered

Code and ADRs reference requirements as `R1`–`R11` — these are the assignment items.

| Code | Requirement                                           | Implementation                                                                                                  |
| ---- | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| R1   | Create a notification, mark as read, list unread      | `src/notifications/notifications.controller.ts`                                                                 |
| R2   | Notifications survive a server restart                | Postgres as the single source of truth; `src/database/`                                                         |
| R3   | NestJS + PostgreSQL + Docker                          | `Dockerfile`, `docker-compose.yml`                                                                              |
| R4   | 500,000 notifications/day                             | partitions + UUIDv7 ([ADR-0002](./adr/en/0002-partitioning-and-uuidv7.md)), [measurements](./en/performance.md) |
| R5   | No more than 10 notifications per minute of one type  | `NotificationsService.create` ([ADR-0004](./adr/en/0004-rate-limit-in-postgres.md))                             |
| R6   | Duplicates within 5 minutes collapse into one         | `dedup_hash` + anchor ([ADR-0003](./adr/en/0003-dedup-window-semantics.md))                                     |
| R7   | Realtime delivery over WebSocket                      | `src/realtime/notifications.gateway.ts`                                                                         |
| R8   | Test page                                             | `public/demo/` → `/demo/`                                                                                       |
| R9   | Offline client receives notifications on next connect | `src/realtime/backlog.replayer.ts`, `undelivered.sweeper.ts`                                                    |
| R10  | Form to send a notification on the test page          | "Ручная отправка" block in `/demo/`                                                                             |
| R11  | Deployed test stand                                   | Railway ([ADR-0007](./adr/en/0007-railway-instead-of-vps-caddy.md)), [guide](./en/deployment.md)                |

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
