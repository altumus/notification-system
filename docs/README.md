# Документация

**Язык / Language:** Русский · [English](./README.en.md)

## Руководства

| Документ                         | Описание                           |
| -------------------------------- | ---------------------------------- |
| [API](./api.md)                  | REST и WebSocket-контракты         |
| [Демо](./demo.md)                | Сценарии тестовой страницы `/demo` |
| [Развёртывание](./deployment.md) | Локально и Railway                 |

## Architecture Decision Records

Решения «почему так, а не иначе» — в каталоге [adr/](./adr/README.md).

| ADR                                                | Тема                           |
| -------------------------------------------------- | ------------------------------ |
| [0001](./adr/0001-kysely-vs-orm.md)                | Kysely вместо ORM              |
| [0002](./adr/0002-partitioning-and-uuidv7.md)      | Партиции + UUIDv7              |
| [0003](./adr/0003-dedup-window-semantics.md)       | Окно дедупликации              |
| [0004](./adr/0004-rate-limit-in-postgres.md)       | Rate limit в Postgres          |
| [0005](./adr/0005-retention.md)                    | Retention через DROP PARTITION |
| [0006](./adr/0006-idempotency-vs-dedup.md)         | Idempotency ≠ dedup            |
| [0007](./adr/0007-railway-instead-of-vps-caddy.md) | Railway вместо VPS+Caddy       |

## Корень репозитория

- [README.md](../README.md) — быстрый старт и стенд
- [PLAN.md](../PLAN.md) — план реализации (внутренний)
