# Architecture Decision Records

**Язык / Language:** Русский · [English](./README.en.md)

Список принятых архитектурных решений. Каждый ADR отвечает на вопрос «почему», а не «как».

| #    | Файл                                                                           | Решение                                               |
| ---- | ------------------------------------------------------------------------------ | ----------------------------------------------------- |
| 0001 | [0001-kysely-vs-orm.md](./0001-kysely-vs-orm.md)                               | Kysely + SQL-миграции вместо ORM                      |
| 0002 | [0002-partitioning-and-uuidv7.md](./0002-partitioning-and-uuidv7.md)           | Помесячные партиции + UUIDv7 как PK                   |
| 0003 | [0003-dedup-window-semantics.md](./0003-dedup-window-semantics.md)             | Фиксированное окно дедупа от якоря                    |
| 0004 | [0004-rate-limit-in-postgres.md](./0004-rate-limit-in-postgres.md)             | Rate limit в Postgres в той же транзакции             |
| 0005 | [0005-retention.md](./0005-retention.md)                                       | Retention через `DROP PARTITION`, выкл. по умолчанию  |
| 0006 | [0006-idempotency-vs-dedup.md](./0006-idempotency-vs-dedup.md)                 | Idempotency-Key отдельно от бизнес-дедупа             |
| 0007 | [0007-railway-instead-of-vps-caddy.md](./0007-railway-instead-of-vps-caddy.md) | Railway вместо VPS + Caddy для стенда                 |
| 0008 | [0008-http-rate-limit.md](./0008-http-rate-limit.md)                           | Транспортный лимит частоты на IP поверх бизнес-лимита |

← [К документации](../README.md) · [README проекта](../../README.md)
