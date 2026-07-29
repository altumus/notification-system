# Документация

**Язык / Language:** Русский · [English](./README.en.md)

## Руководства

| Документ                               | Описание                             |
| -------------------------------------- | ------------------------------------ |
| [API](./api.md)                        | REST и WebSocket-контракты           |
| [Демо](./demo.md)                      | Сценарии тестовой страницы `/demo`   |
| [Развёртывание](./deployment.md)       | Локально и Railway                   |
| [Производительность](./performance.md) | Нагрузочные профили k6 и целевые p95 |

## Требования и где они закрыты

Код и ADR ссылаются на требования по кодам `R1`–`R11` — это пункты тестового задания.

| Код | Требование                                                      | Где реализовано                                                                                                                                        |
| --- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| R1  | Создать уведомление, пометить прочитанным, список непрочитанных | `src/notifications/notifications.controller.ts`                                                                                                        |
| R2  | Уведомления не теряются при рестарте сервера                    | Postgres как единственный источник истины; тест `test/e2e/restart-durability.e2e-spec.ts`                                                              |
| R3  | NestJS + PostgreSQL + Docker                                    | `Dockerfile`, `docker-compose.yml`                                                                                                                     |
| R4  | 500 000 уведомлений/сутки                                       | партиции + UUIDv7 ([ADR-0002](./adr/0002-partitioning-and-uuidv7.md)), [замеры](./performance.md)                                                      |
| R5  | Не больше 10 уведомлений в минуту одного типа                   | `NotificationsService.create` ([ADR-0004](./adr/0004-rate-limit-in-postgres.md)); транспортный лимит на IP — [ADR-0008](./adr/0008-http-rate-limit.md) |
| R6  | Дубли за 5 минут схлопываются в одно                            | `dedup_hash` + якорь ([ADR-0003](./adr/0003-dedup-window-semantics.md))                                                                                |
| R7  | Realtime-доставка по WebSocket                                  | `src/realtime/notifications.gateway.ts`                                                                                                                |
| R8  | Тестовая страница                                               | `public/demo/` → `/demo/`                                                                                                                              |
| R9  | Офлайн-клиент получает уведомления при подключении              | `src/realtime/backlog.replayer.ts`, `undelivered.sweeper.ts`                                                                                           |
| R10 | Форма отправки уведомления на тестовой странице                 | блок «Ручная отправка» в `/demo/`                                                                                                                      |
| R11 | Развёрнутый тестовый стенд                                      | Railway ([ADR-0007](./adr/0007-railway-instead-of-vps-caddy.md)), [инструкция](./deployment.md)                                                        |

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
| [0008](./adr/0008-http-rate-limit.md)              | Лимит частоты запросов на IP   |

## Корень репозитория

- [README.md](../README.md) — быстрый старт и стенд
