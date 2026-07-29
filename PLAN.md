# Notification System — план реализации по коммитам

Документ-задание для ИИ-исполнителя. Содержит: архитектурные решения (принятые, не обсуждаемые), контракты API/WS, полный DDL и пошаговый план из 24 коммитов. Исполнитель должен идти строго по порядку, не забегая вперёд: каждый коммит атомарен, собирается и проходит CI самостоятельно.

---

## 0. Исходное тестовое задание (дословно)

> Нужно сделать API для системы уведомлений: создать уведомление, пометить прочитанным, получить список непрочитанных. NestJS + PostgreSQL + Docker.
> Уведомления не должны теряться при рестарте сервера. И система должна выдерживать 500k уведомлений/день.
> Один пользователь не должен получать больше 10 уведомлений в минуту одного типа. Дубли за 5 минут схлопываются в одно.
> Клиент подключается по WebSocket и получает уведомления в реальном времени. Сделать тестовую страницу. Если клиент офлайн — уведомление сохраняется и приходит при следующем подключении. Сделать тестовую форму где можно отправить уведомление.
> Оформить с комментариями и пояснениями на каждый метод.
> Развернуть на тестовом сервере.

### Трассировка требований → коммиты

| #   | Требование                                                  | Где закрывается | Чем доказывается                                              |
| --- | ----------------------------------------------------------- | --------------- | ------------------------------------------------------------- |
| R1  | REST: создать / пометить прочитанным / список непрочитанных | 07, 08, 09      | e2e-тесты + Swagger                                           |
| R2  | NestJS + PostgreSQL + Docker                                | 01–04           | `docker compose up` поднимает всё одной командой              |
| R3  | Не теряются при рестарте                                    | 04, 13, 14, 18  | тест 18: рестарт контейнера под нагрузкой, 0 потерь           |
| R4  | 500k уведомлений/день                                       | 04, 05, 19      | партиционирование + k6-отчёт в `docs/performance.md`          |
| R5  | Лимит 10/мин на (пользователь, тип)                         | 07              | unit + integration, включая конкурентные запросы              |
| R6  | Дубли за 5 минут схлопываются                               | 06, 07          | integration: внутри/вне окна + гонки                          |
| R7  | WebSocket в реальном времени                                | 12, 13          | e2e через `socket.io-client`                                  |
| R8  | Тестовая страница + форма отправки                          | 16              | `GET /demo`                                                   |
| R9  | Офлайн → доставка при подключении                           | 14              | e2e: отправка при отключённом клиенте → реконнект → получение |
| R10 | Комментарии/пояснения на каждый метод                       | все             | ESLint-правило `jsdoc/require-jsdoc` падает в CI              |
| R11 | Развёрнуто на тестовом сервере                              | 21, 22          | публичный HTTPS/WSS-URL в README                              |

---

## 1. Правила для исполнителя (обязательны к соблюдению)

1. **Один коммит = один пункт плана.** Не объединять, не переставлять. Перед коммитом: `pnpm lint && pnpm typecheck && pnpm test` — всё зелёное.
2. **Conventional Commits.** Заголовок ≤ 72 символов, тело — 2–5 строк «зачем так сделано» (это читает ревьюер тестового).
3. **TSDoc на каждом экспортируемом классе, методе, функции** — на русском языке. Обязательный формат:
   ```ts
   /**
    * Краткое описание: что делает метод (одна строка).
    *
    * Зачем: почему метод существует / какое требование закрывает.
    * Как: ключевые детали реализации, важные для читателя (блокировки, транзакции, сложность).
    *
    * @param userId - идентификатор получателя (UUID, приходит из JWT)
    * @returns Список непрочитанных уведомлений и курсор для следующей страницы
    * @throws {RateLimitExceededError} Если превышен лимит 10/мин для этого типа
    */
   ```
   Идентификаторы в коде — только английские. Комментарии, README, ADR — русский.
4. **TypeScript strict.** Запрещены `any`, `as unknown as`, `@ts-ignore`, non-null `!` (кроме обоснованных случаев с комментарием). `noUncheckedIndexedAccess: true`, `exactOptionalPropertyTypes: true`.
5. **Никаких `TODO`, закомментированного кода, мёртвых файлов, заглушек.** Если что-то не реализуется — это осознанное решение, зафиксированное в ADR или в разделе «Ограничения» README.
6. **Тесты в том же коммите, что и код.** Тест без кода и код без теста — не коммитятся.
7. **Валидация на границе.** Любой внешний ввод (HTTP-тело, query, WS-payload, env) валидируется схемой; внутрь домена попадают только типизированные объекты.
8. **Никаких изменений в файлах, не относящихся к текущему коммиту** (в т.ч. переформатирования).
9. **Все SQL-запросы — параметризованные.** Конкатенация строк в SQL запрещена.
10. **Ошибки** отдаются в формате RFC 9457 (`application/problem+json`), внутренние детали не утекают наружу, но логируются с `requestId`.

---

## 2. Технологический стек (решено)

| Слой        | Выбор                                                                                            | Почему именно так (в ADR)                                                                                                                                                                                                                                    |
| ----------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Runtime     | Node.js 22 LTS, pnpm                                                                             | LTS + быстрый и детерминированный менеджер пакетов                                                                                                                                                                                                           |
| Framework   | NestJS 11 (Express-адаптер)                                                                      | Требование задания; DI и модульность нужны для чистых слоёв                                                                                                                                                                                                  |
| БД          | PostgreSQL 17                                                                                    | Требование задания                                                                                                                                                                                                                                           |
| Доступ к БД | `pg` (Pool) + **Kysely** (типизированный query-builder)                                          | Нужен полный контроль над DDL: декларативное партиционирование, партиальные индексы, `pg_advisory_xact_lock`, `FOR UPDATE`. ORM (Prisma/TypeORM) с партиционированными таблицами конфликтует на diff/миграциях. Kysely даёт типы без потери контроля над SQL |
| Миграции    | `node-pg-migrate`, миграции в чистом `.sql`                                                      | Ревьюер видит настоящий SQL, а не сгенерированный                                                                                                                                                                                                            |
| Realtime    | Socket.IO 4 (`@nestjs/websockets`)                                                               | Rooms, ack-и, авто-reconnect, простой браузерный клиент для демо-страницы                                                                                                                                                                                    |
| Валидация   | Zod (env + WS payload) + `class-validator`/`class-transformer` (HTTP DTO, чтобы работал Swagger) | Swagger-декораторы требуют классов; env удобнее описывать Zod                                                                                                                                                                                                |
| Логи        | `nestjs-pino` + `pino-http`, `requestId` через `AsyncLocalStorage`                               | Структурные логи, корреляция HTTP → WS → SQL                                                                                                                                                                                                                 |
| Метрики     | `prom-client`, `GET /metrics`                                                                    | Доказательство пропускной способности                                                                                                                                                                                                                        |
| Тесты       | Jest + Supertest + `@testcontainers/postgresql` + `socket.io-client`                             | Реальный Postgres в тестах, без моков репозитория                                                                                                                                                                                                            |
| Нагрузка    | k6                                                                                               | Скрипт + отчёт в репозитории                                                                                                                                                                                                                                 |
| Docker      | multi-stage Dockerfile, `docker compose`                                                         | Требование задания                                                                                                                                                                                                                                           |
| Продакшн    | VPS + `docker compose` + Caddy (авто-TLS)                                                        | Нужен настоящий `wss://` по домену для демо                                                                                                                                                                                                                  |
| CI          | GitHub Actions                                                                                   | lint/typecheck/test/build/push образа                                                                                                                                                                                                                        |
| Redis       | **опционально**, только для Socket.IO-адаптера при горизонтальном масштабировании (коммит 15)    | Ядро (дедуп, лимиты, durability) работает на одном Postgres — иначе появляется второй источник истины                                                                                                                                                        |

### Структура каталогов (целевая)

```
.
├─ src/
│  ├─ main.ts                        # bootstrap: helmet, cors, pipes, swagger, shutdown hooks
│  ├─ app.module.ts
│  ├─ common/                        # кросс-модульная инфраструктура
│  │  ├─ config/                     # zod-схема env + ConfigService
│  │  ├─ logging/                    # pino, request-id middleware, ALS-контекст
│  │  ├─ errors/                     # доменные ошибки + ProblemDetails-фильтр
│  │  ├─ pagination/                 # keyset-курсоры (encode/decode)
│  │  └─ utils/                      # uuidv7 (генерация + декодирование ts), canonical-json, sha256
│  ├─ database/                      # Pool, KyselyService, типы схемы, health-indicator
│  │  ├─ migrations/                 # *.sql (node-pg-migrate)
│  │  └─ maintenance/                # партиции + retention (cron)
│  ├─ auth/                          # dev-JWT: выдача токена, HTTP-guard, WS-guard
│  ├─ notifications/
│  │  ├─ domain/                     # типы, конфиг типов уведомлений, dedup-hash, ошибки
│  │  ├─ dto/                        # HTTP DTO (class-validator + swagger)
│  │  ├─ notifications.repository.ts # весь SQL
│  │  ├─ notifications.service.ts    # бизнес-правила (дедуп, лимит, чтение)
│  │  ├─ notifications.controller.ts # REST
│  │  └─ idempotency/                # Idempotency-Key интерцептор + стор
│  ├─ realtime/
│  │  ├─ notifications.gateway.ts    # Socket.IO
│  │  ├─ presence.registry.ts        # кто сейчас онлайн (in-memory | redis)
│  │  ├─ delivery.dispatcher.ts      # after-commit push
│  │  └─ backlog.replayer.ts         # догон недоставленного + sweeper
│  ├─ observability/                 # prom-client метрики
│  └─ health/                        # /health/live, /health/ready
├─ public/demo/                      # тестовая страница (index.html, app.js, styles.css)
├─ test/
│  ├─ unit/  integration/  e2e/  reliability/
├─ load/                             # k6-скрипты
├─ docs/
│  ├─ architecture.md  api.md  performance.md  deployment.md  testing.md
│  └─ adr/0001..0009-*.md
├─ deploy/                           # docker-compose.prod.yml, Caddyfile, deploy.sh, backup.sh
├─ .github/workflows/ci.yml
├─ Dockerfile  docker-compose.yml  .env.example  Makefile
└─ README.md
```

---

## 3. Ключевые архитектурные решения (реализовывать буквально)

### 3.1 Идентификаторы: UUIDv7 + вывод `created_at` из id

- `id` генерируется приложением как **UUIDv7** (`uuid@11`, `v7({ msecs })`) — монотонный по времени, даёт локальность вставки в B-tree (в отличие от UUIDv4, который разносит вставки по всему индексу).
- Таблица партиционирована по `created_at`, поэтому первичный ключ — составной: `PRIMARY KEY (id, created_at)`.
- Чтобы API оставалось «по id» (`PATCH /notifications/:id/read`), `created_at` **выводится из самого id**: из UUIDv7 читаются старшие 48 бит = миллисекунды Unix. Условие `WHERE id = $1 AND created_at = $2` даёт partition pruning вместо сканирования всех партиций.
- **Инвариант, который нельзя нарушать:** `created_at` записывается ровно как `new Date(msecs)`, из тех же `msecs`, из которых собран UUIDv7 (миллисекундная точность, без микросекунд). Иначе равенство перестанет совпадать.
- `msecs` берётся **из БД**, а не из процесса: транзакция начинается запросом, который одновременно ставит advisory-lock и возвращает время сервера БД (см. 3.4). Это устраняет расхождение часов между инстансами приложения.

### 3.2 Дедупликация (R6): фиксированное окно от первого вхождения

- `dedup_hash = sha256(user_id | type | canonicalJson(dedupPayload))`, где `canonicalJson` — рекурсивная сериализация с сортировкой ключей (порядок ключей в JSON не должен влиять на хеш).
- По умолчанию в хеш идёт весь `payload`. Для типа можно указать `dedupKeys: ['orderId']` — тогда в хеш идут только эти поля (реальный кейс: «заказ обновился 20 раз, схлопни по orderId»).
- **Семантика окна — фиксированное окно, привязанное к `created_at` уже существующего уведомления:** дубль, пришедший в течение 5 минут после создания «якоря», не создаёт новую запись, а инкрементит `occurrences` и обновляет `last_seen_at` у якоря.
- Почему фиксированное, а не скользящее «от последнего дубля»: при скользящем окне поток дублей каждые 4 минуты бесконечно продлевает жизнь одной записи, и пользователь навсегда перестаёт получать новые уведомления. Плюс фиксированное окно позволяет ограничить поиск по `created_at` и получить partition pruning. Компромисс зафиксировать в ADR-0003.
- Схлопывание **не** порождает повторный WS-push и **не** сбрасывает `read_at`: «схлопываются в одно» = одно уведомление, а не два. В ответе возвращается `status: "deduplicated"` и текущее значение `occurrences` — клиент может показать «×3».

### 3.3 Rate limit (R5): 10 в минуту на (user_id, type)

- Считается в **Postgres**, в той же транзакции, что и вставка: `count(*)` по `(user_id, type, created_at > now - 1 min)` с индексом `notifications_ratelimit_idx`. Это делает лимит консистентным и устойчивым к рестарту (нет счётчиков в памяти, которые обнуляются).
- В окно попадают только **принятые** уведомления (созданные строки). Отклонённые попытки и схлопнутые дубли лимит не расходуют — иначе один спамящий продюсер заблокировал бы полезные уведомления.
- Гонки исключаются advisory-локом на `(user_id, type)` (см. 3.4): без него два параллельных запроса могут увидеть 9 и создать 11-е.
- Лимит и окно конфигурируемы глобально (env) и переопределяемы для конкретного типа в конфиге типов.
- При превышении — `429` + заголовки `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset`, `Retry-After` (вычисляется из `min(created_at)` в окне).
- В ADR-0004 отметить: при росте до тысяч RPS горячий счётчик выносится в Redis (Lua, скользящее окно ZSET), Postgres остаётся источником истины; интерфейс `RateLimiter` уже позволяет подменить реализацию.

### 3.4 Атомарность создания: одна транзакция + advisory lock

Ключ блокировки — `(user_id, type)`, он покрывает **и** дедуп (dedup_hash всегда включает user+type), **и** rate limit. Блокировка транзакционная (`pg_advisory_xact_lock`), снимается автоматически при commit/rollback/падении соединения — рестарт сервера не оставляет висящих локов.

```
BEGIN;
  -- 1. Сериализация по (user, type) + единый источник времени.
  SELECT pg_advisory_xact_lock(hashtextextended($userType, 0)), clock_timestamp() AS now;
  --    msecs = floor(now → ms); id = uuidv7(msecs); createdAt = new Date(msecs)

  -- 2. Поиск якоря для схлопывания (окно 5 минут по created_at).
  SELECT id, created_at, occurrences, read_at
    FROM notifications
   WHERE user_id = $1 AND type = $2 AND dedup_hash = $3
     AND created_at > $now - $dedupWindow::interval
   ORDER BY created_at DESC
   LIMIT 1
     FOR UPDATE;
  -- если найден → UPDATE occurrences = occurrences + 1, last_seen_at = $now
  --               COMMIT; вернуть { status: 'deduplicated' }; WS-push НЕ делать

  -- 3. Rate limit.
  SELECT count(*)::int AS used, min(created_at) AS oldest
    FROM notifications
   WHERE user_id = $1 AND type = $2 AND created_at > $now - $rateWindow::interval;
  -- если used >= limit → ROLLBACK; throw RateLimitExceededError(retryAfterMs)

  -- 4. Вставка.
  INSERT INTO notifications (id, user_id, type, payload, dedup_hash, created_at, last_seen_at)
  VALUES ($id, $1, $2, $payload::jsonb, $3, $createdAt, $createdAt)
  RETURNING *;
COMMIT;

-- 5. ТОЛЬКО ПОСЛЕ COMMIT: попытка WS-доставки.
--    Если push не удался / инстанс упал — delivered_at остаётся NULL,
--    запись догонит sweeper или replay при следующем подключении.
```

Порядок «commit → push» — это упрощённый transactional outbox: БД всегда источник истины, WS — лучший-случай ускорение. Отсюда напрямую следует R3 и R9.

### 3.5 Доставка и durability (R3, R9)

- Состояние доставки — колонка `delivered_at` (а не отдельная таблица outbox): при партиционировании + партиальном индексе `WHERE delivered_at IS NULL` «горячий хвост» недоставленного остаётся крошечным, а лишний join и вторая точка записи не появляются.
- Гарантия — **at-least-once**: сервер помечает `delivered_at` только после **ack клиента** (Socket.IO ack-callback). Клиент обязан дедуплицировать по `id` (в демо-странице это реализовано и подписано в UI).
- Три пути, которыми уведомление доходит до клиента:
  1. **live push** — сразу после commit, если пользователь онлайн;
  2. **replay при подключении** — при `connection` сервер отдаёт `delivered_at IS NULL` порциями по 100, по возрастанию `created_at`, с ack на каждую порцию (это и есть «офлайн → придёт при следующем подключении»);
  3. **sweeper** — cron раз в N секунд добирает `delivered_at IS NULL` для пользователей, которые онлайн (страховка от падения инстанса между commit и push и от потерянных ack-ов).
- Явно задокументировать в `docs/architecture.md`: единственный способ «потерять» уведомление — потеря самой БД, поэтому в `deploy/backup.sh` есть `pg_dump` по расписанию.

### 3.6 Масштаб 500k/день (R4)

Расчёт для README (обязательно привести):

- 500 000 / 86 400 ≈ **5.8 RPS** в среднем; пик × 10 ≈ **60 RPS**; целевой запас в нагрузочном тесте — **≥ 300 RPS**, p95 создания < 50 мс.
- Строка ≈ 250 Б + 4 индекса ≈ 500 Б → **~250 МБ/сутки**, ~7.5 ГБ/мес, ~90 ГБ/год.
- Отсюда: **декларативное партиционирование по месяцам** (`PARTITION BY RANGE (created_at)`), автосоздание партиций на 2 месяца вперёд, `DEFAULT`-партиция как страховка, retention: `DROP PARTITION` старше N месяцев (по умолчанию 6, отключаемо). Удаление данных через `DROP TABLE` партиции — O(1), без `VACUUM`-долга от массового `DELETE`.
- Пул соединений: `max` по формуле из README (по умолчанию 10 на инстанс), `statement_timeout`, `idle_in_transaction_session_timeout`, `application_name` — чтобы всплеск не съел все коннекты Postgres.

---

## 4. Контракты

### 4.1 REST (`/api/v1`, Swagger на `/api/docs`)

| Метод   | Путь                             | Назначение                                                                            | Ответы                                                   |
| ------- | -------------------------------- | ------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `POST`  | `/notifications`                 | Создать уведомление (сервер-к-серверу). Заголовки: `Authorization: Bearer <service    | user token>`, опционально `Idempotency-Key`              | `201 {status:"created", notification}` · `200 {status:"deduplicated", notification}` · `422` · `429` |
| `GET`   | `/notifications/unread`          | Непрочитанные, keyset-пагинация `?limit=1..100&cursor=`                               | `200 {items, nextCursor, unreadCount, unreadCountExact}` |
| `GET`   | `/notifications/unread/count`    | Только счётчик (для бейджа)                                                           | `200 {count, exact}`                                     |
| `PATCH` | `/notifications/:id/read`        | Пометить прочитанным (идемпотентно)                                                   | `200 {notification}` · `404`                             |
| `POST`  | `/notifications/read-all`        | Пометить всё прочитанным                                                              | `200 {updated}`                                          |
| `POST`  | `/auth/dev-token`                | Выдать JWT для произвольного `userId` — **только при `AUTH_DEV_TOKENS_ENABLED=true`** | `201 {token, userId, expiresIn}` · `404` в прод-режиме   |
| `GET`   | `/health/live` · `/health/ready` | Liveness / readiness (readiness проверяет БД)                                         | `200` · `503`                                            |
| `GET`   | `/metrics`                       | Prometheus                                                                            | `200 text/plain`                                         |

Форма объекта уведомления (единая для REST и WS):

```json
{
  "id": "018f...-7...-...",
  "userId": "…",
  "type": "order.status_changed",
  "payload": { "orderId": 42, "status": "shipped" },
  "occurrences": 3,
  "createdAt": "2026-07-29T10:15:00.123Z",
  "lastSeenAt": "2026-07-29T10:18:41.007Z",
  "readAt": null,
  "deliveredAt": null
}
```

Ошибки — `application/problem+json`:

```json
{
  "type": "https://example.com/problems/rate-limit-exceeded",
  "title": "Превышен лимит уведомлений",
  "status": 429,
  "detail": "Для типа order.status_changed разрешено 10 уведомлений в минуту",
  "instance": "/api/v1/notifications",
  "requestId": "01J…",
  "limit": 10,
  "windowMs": 60000,
  "retryAfterMs": 12480
}
```

### 4.2 WebSocket (Socket.IO, namespace `/ws/notifications`)

Подключение: `io(URL + '/ws/notifications', { auth: { token }, transports: ['websocket'] })`.
Неверный/просроченный токен → `connect_error` с кодом `unauthorized`, соединение закрывается.

Server → client:

| Событие                | Payload                                           | Смысл                                         |
| ---------------------- | ------------------------------------------------- | --------------------------------------------- |
| `connection.ready`     | `{ userId, socketId, serverTime, unreadCount }`   | Хендшейк пройден, можно рисовать UI           |
| `notification.created` | `Notification` (ack: `{ ok: true }`)              | Live-доставка; `delivered_at` ставится по ack |
| `notification.backlog` | `{ items: Notification[], batch, hasMore }` (ack) | Догон недоставленного при подключении         |
| `notification.read`    | `{ id, readAt }`                                  | Синхронизация между вкладками/устройствами    |

Client → server:

| Событие                    | Payload                                           | Смысл                                                      |
| -------------------------- | ------------------------------------------------- | ---------------------------------------------------------- |
| `notification.ack`         | `{ ids: string[] }`                               | Явное подтверждение (резерв для клиентов без ack-callback) |
| `notification.read`        | `{ id }` → ack `{ notification }`                 | Пометить прочитанным по WS                                 |
| `notification.fetchUnread` | `{ limit, cursor }` → ack `{ items, nextCursor }` | Подгрузка списка без REST                                  |

---

## 5. План коммитов

> Формат каждого пункта: **Цель** → **Файлы** → **Реализация** → **Проверка** → **Сообщение коммита**.

---

### Коммит 00 — Базовая инфраструктура репозитория

**Цель.** Инструменты качества настроены до появления кода, чтобы правила действовали с первой строки.

**Файлы.** `package.json`, `pnpm-workspace.yaml` (если нужен), `tsconfig.json`, `tsconfig.build.json`, `eslint.config.mjs`, `.prettierrc`, `.editorconfig`, `.nvmrc`, `.gitignore`, `.gitattributes`, `commitlint.config.cjs`, `.husky/*`, `lint-staged.config.js`, `LICENSE`, `README.md` (скелет), `.github/workflows/ci.yml`, `Makefile`.

**Реализация.**

- `tsconfig`: `strict: true`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, `noFallthroughCasesInSwitch`, `target: ES2023`, `module: NodeNext`, `paths: { "@/*": ["src/*"] }`.
- ESLint (flat config): `typescript-eslint` (strict-type-checked), `eslint-plugin-import` (порядок импортов), `eslint-plugin-jsdoc`, `eslint-plugin-sonarjs` (опц.), `eslint-plugin-unicorn` (умеренно).
  **Критично для R10:** включить `jsdoc/require-jsdoc` для `MethodDefinition`, `FunctionDeclaration`, `ClassDeclaration` (только `public`/exported), плюс `jsdoc/require-param`, `jsdoc/require-param-description`, `jsdoc/require-returns`, `jsdoc/require-description`. Уровень — `error`. Это машинная гарантия «комментарий на каждый метод».
- Скрипты: `dev`, `build`, `start`, `lint`, `lint:fix`, `format`, `typecheck`, `test`, `test:unit`, `test:integration`, `test:e2e`, `test:cov`, `migrate:up`, `migrate:down`, `migrate:create`.
- `Makefile`: `up`, `down`, `logs`, `psql`, `migrate`, `seed`, `test`, `load`, `deploy` — короткие команды для ревьюера.
- CI: job `quality` (install → lint → typecheck → build) на push/PR, кеш pnpm. Тестовые джобы добавятся в коммите 18 — сейчас их не изобретать.
- README: название, стек, «в разработке», ссылка на `PLAN.md`.

**Проверка.** `pnpm install && pnpm lint && pnpm typecheck` — успешно; `git commit` с неверным заголовком отклоняется commitlint-ом.

**Сообщение.** `chore(repo): настроить тулинг, строгий TS и обязательный JSDoc`

---

### Коммит 01 — Скелет NestJS: конфиг, логи, ошибки, Swagger

**Цель.** Приложение поднимается, отдаёт `/api/docs`, валидирует env на старте и корректно завершается.

**Файлы.** `src/main.ts`, `src/app.module.ts`, `src/common/config/*`, `src/common/logging/*`, `src/common/errors/*`, `src/health/*`, `test/unit/config.spec.ts`.

**Реализация.**

- `src/common/config/env.schema.ts` — Zod-схема **всех** переменных с дефолтами и описаниями: `NODE_ENV`, `PORT`, `LOG_LEVEL`, `DATABASE_URL`, `DB_POOL_MAX`, `DB_STATEMENT_TIMEOUT_MS`, `JWT_SECRET`, `JWT_TTL`, `AUTH_DEV_TOKENS_ENABLED`, `NOTIFICATIONS_RATE_LIMIT`, `NOTIFICATIONS_RATE_WINDOW_MS`, `NOTIFICATIONS_DEDUP_WINDOW_MS`, `WS_PATH`, `WS_BACKLOG_BATCH_SIZE`, `SWEEPER_INTERVAL_MS`, `PARTITION_LOOKAHEAD_MONTHS`, `RETENTION_MONTHS`, `RETENTION_ENABLED`, `CORS_ORIGINS`, `REDIS_URL` (опц.), `METRICS_ENABLED`.
  Падать на старте с человекочитаемым списком проблем (fail fast). Типизированный `AppConfigService` (обёртка, отдающая уже разобранные значения — без `process.env` в коде дальше).
- Логи: `nestjs-pino`, `genReqId` (UUIDv7), редакция `authorization`/`token`/`payload.*` при `NODE_ENV=production`, pretty-transport только в dev. `AsyncLocalStorage`-хранилище `requestId`, доступное из сервисов и WS-хендлеров.
- Ошибки: базовый `DomainError` (code, httpStatus, detail, meta) + `AllExceptionsFilter`, отдающий `application/problem+json`; `5xx` логируются со стеком, наружу — без деталей.
- `main.ts`: `helmet`, `cors` (из конфига), `ValidationPipe({ whitelist, forbidNonWhitelisted, transform })`, `app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' })`, `app.setGlobalPrefix('api')`, `app.enableShutdownHooks()`, `SwaggerModule` с описанием, тегами и bearer-схемой, обработчики `SIGTERM`/`SIGINT` с graceful-закрытием.
- `HealthModule` на `@nestjs/terminus`: `/health/live` (всегда 200, пока процесс жив), `/health/ready` (позже добавится БД-индикатор).
- TSDoc на всём.

**Проверка.** `pnpm dev` → `GET /health/live` = 200, `/api/docs` открывается; удаление обязательной env-переменной валит старт с внятным сообщением; unit-тест на env-схему (валидные/невалидные наборы).

**Сообщение.** `feat(app): поднять каркас NestJS с валидацией env, логами и problem+json`

---

### Коммит 02 — Docker-окружение для разработки

**Цель.** `make up` поднимает Postgres + приложение на любой машине.

**Файлы.** `Dockerfile`, `.dockerignore`, `docker-compose.yml`, `.env.example`, `docs/deployment.md` (раздел «локально»).

**Реализация.**

- Multi-stage `Dockerfile`: `deps` (pnpm fetch/install --frozen-lockfile) → `build` (tsc) → `runtime` (`node:22-alpine`, `pnpm install --prod`, `USER node`, `dumb-init` как PID 1, `HEALTHCHECK` на `/health/live`, `NODE_OPTIONS`/`--max-old-space-size`). Отдельный стейдж `dev` с hot-reload.
- `docker-compose.yml`: сервис `postgres:17-alpine` (volume, `healthcheck: pg_isready`, tuning-параметры через `command`), сервис `migrate` (one-shot, `depends_on: postgres healthy`), сервис `api` (`depends_on: migrate completed`), сервис `redis:7-alpine` под профилем `scale` (не поднимается по умолчанию).
- `.env.example` — все переменные с комментариями и безопасными дефолтами; секреты — плейсхолдеры.
- В README — блок «Быстрый старт: 3 команды».

**Проверка.** `docker compose up -d` на чистой машине → `curl localhost:3000/health/live` = 200; образ `runtime` не содержит devDependencies и исходников TS; контейнер работает не от root (`docker exec … whoami` → `node`).

**Сообщение.** `feat(docker): добавить dev-окружение (multi-stage образ + compose)`

---

### Коммит 03 — Подключение к Postgres: пул, миграции, readiness

**Цель.** Типизированный доступ к БД, инфраструктура миграций, `/health/ready` действительно проверяет БД.

**Файлы.** `src/database/database.module.ts`, `src/database/pool.provider.ts`, `src/database/kysely.service.ts`, `src/database/schema.types.ts`, `src/database/database.health.ts`, `src/database/transaction.helper.ts`, `migrations/` + конфиг `node-pg-migrate`, `test/integration/database.spec.ts`, `test/setup/testcontainers.ts`.

**Реализация.**

- `pg.Pool` c `max`, `connectionTimeoutMillis`, `idleTimeoutMillis`, `application_name`, `statement_timeout`, `idle_in_transaction_session_timeout` из конфига. Логировать `error` пула, не падать процессом.
- `KyselyService` (`PostgresDialect` над тем же пулом), `onModuleDestroy` → `destroy()`.
- `schema.types.ts` — интерфейс `Database` с таблицами (пока пустой/минимальный, наполняется в 04). Скрипт `db:types:check` через `kysely-codegen` сравнивает описанные типы с реальной схемой (защита от рассинхрона), запускается в CI позже.
- `withTransaction(fn)` — хелпер: `BEGIN`/`COMMIT`/`ROLLBACK`, проброс ошибок, **ретрай на `40001`/`40P01`** (serialization/deadlock) с экспоненциальной задержкой, максимум 3 попытки. Задокументировать, почему ретрай безопасен (транзакция идемпотентна по построению).
- `DatabaseHealthIndicator` — `SELECT 1` с таймаутом; подключить в `/health/ready`.
- Тестовая инфраструктура: `@testcontainers/postgresql`, поднимающий Postgres 17 один раз на прогон (globalSetup), применяющий миграции; helper `truncateAll()` между тестами.

**Проверка.** `pnpm test:integration` — контейнер поднимается, тест `SELECT 1` проходит; остановленный Postgres → `/health/ready` = 503, `/health/live` = 200.

**Сообщение.** `feat(db): подключить пул Postgres, Kysely, миграции и readiness-проверку`

---

### Коммит 04 — Схема `notifications`: партиционирование и индексы

**Цель.** Хранилище, спроектированное под 500k/сутки и под запросы из раздела 3.

**Файлы.** `migrations/1700000000000_init-notifications.sql`, обновление `src/database/schema.types.ts`, `docs/adr/0001-kysely-vs-orm.md`, `docs/adr/0002-partitioning-and-uuidv7.md`, `test/integration/schema.spec.ts`.

**Реализация (SQL — писать именно так).**

```sql
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
```

- В `down`-миграции — аккуратный `DROP TABLE notifications CASCADE` + `DROP FUNCTION`.
- ADR-0002 объясняет: почему RANGE по `created_at`, почему PK составной, почему UUIDv7, как вывод `created_at` из id даёт pruning, чем плоха таблица без партиций на 182M строк/год, цена 4 индексов на запись.
- `schema.types.ts` — интерфейс `NotificationsTable` (`Generated`, `ColumnType` для timestamptz/jsonb/bytea).
- Integration-тест: партиции существуют; вставка попадает в нужную партицию (`tableoid::regclass`); `EXPLAIN` для запроса непрочитанных использует `notifications_unread_idx`; `EXPLAIN` для mark-as-read с `created_at` сканирует **одну** партицию; вставка с датой вне диапазона уходит в `notifications_default`.

**Проверка.** `pnpm migrate:up && pnpm test:integration`.

**Сообщение.** `feat(db): описать партиционированную схему notifications с целевыми индексами`

---

### Коммит 05 — Обслуживание партиций и retention

**Цель.** Партиции создаются заранее автоматически, старые данные удаляются дёшево — система живёт годами без ручных операций.

**Файлы.** `src/database/maintenance/partition-maintenance.service.ts`, `retention.service.ts`, `maintenance.module.ts`, `test/integration/partition-maintenance.spec.ts`, `docs/adr/0005-retention.md`.

**Реализация.**

- `@nestjs/schedule`, cron раз в сутки (+ один прогон на `onApplicationBootstrap`): гарантировать наличие партиций на `PARTITION_LOOKAHEAD_MONTHS` вперёд через `ensure_notifications_partition`.
- Проверка `notifications_default`: если в ней появились строки — `WARN` в логах и метрика (это сигнал, что автосоздание отстало).
- `RetentionService`: при `RETENTION_ENABLED=true` находит партиции старше `RETENTION_MONTHS` и делает `DROP TABLE` (только партиции, соответствующие строгому regexp имени — никаких динамических имён из непроверенного источника). По умолчанию **выключено**, и в логах на старте пишется, что удаление отключено.
- Защита от параллельного выполнения на нескольких инстансах: `pg_try_advisory_lock` на фиксированном ключе; не получил лок — тихо выходим.
- Все методы с TSDoc, в котором объяснено, почему `DROP PARTITION` предпочтительнее `DELETE`.

**Проверка.** Integration-тест: создать «древнюю» партицию, включить retention, прогнать джобу → партиция удалена, свежие данные целы; повторный вызов создания партиций идемпотентен.

**Сообщение.** `feat(db): автосоздание партиций и retention через drop partition`

---

### Коммит 06 — Доменные примитивы уведомлений

**Цель.** Чистые, полностью покрытые тестами кирпичики: id, канонический хеш, конфиг типов, DTO. Без БД и HTTP.

**Файлы.** `src/common/utils/uuid-v7.ts`, `canonical-json.ts`, `src/notifications/domain/notification-type.config.ts`, `dedup-hash.ts`, `notification.entity.ts`, `notification.mapper.ts`, `errors.ts`, `src/notifications/dto/*.ts`, `src/common/pagination/keyset-cursor.ts`, `test/unit/*.spec.ts`, `docs/adr/0003-dedup-window-semantics.md`, `docs/adr/0004-rate-limit-in-postgres.md`.

**Реализация.**

- `uuid-v7.ts`: `newUuidV7(msecs)` (через `uuid@11` `v7`), `uuidV7ToDate(id)` — читает старшие 48 бит; `assertUuidV7(id)`. Явно задокументировать инвариант из 3.1 и то, что для не-v7 UUID функция бросает ошибку (иначе partition pruning молча сломается).
- `canonical-json.ts`: детерминированная сериализация (сортировка ключей рекурсивно, стабильная запись чисел, отказ на циклы/`undefined`).
- `dedup-hash.ts`: `buildDedupHash({ userId, type, payload, dedupKeys })` → `Buffer` sha256.
- `notification-type.config.ts`: реестр типов — `{ type, rateLimit?, rateWindowMs?, dedupWindowMs?, dedupKeys?, title? }`, дефолты из env, ≥ 5 реалистичных типов для демо (`order.status_changed`, `chat.message`, `system.alert`, `payment.failed`, `friend.request`). Метод `resolve(type)` возвращает эффективные настройки; неизвестный тип разрешён и получает дефолты (обосновать: продюсеры не должны ждать релиза, чтобы добавить тип).
- DTO: `CreateNotificationDto` (`userId: uuid`, `type` по regexp, `payload` — объект с лимитом размера, `@ApiProperty` с примерами), `GetUnreadQueryDto` (`limit` 1..100 default 20, `cursor` строка), response-DTO. Ограничение размера payload (например 8 КБ) — валидатором, а не только body-limit.
- `keyset-cursor.ts`: `encode({createdAt, id})` / `decode()` в base64url, с версией формата и валидацией (битый курсор → 422, а не 500).
- `errors.ts`: `RateLimitExceededError`, `NotificationNotFoundError`, `InvalidCursorError` — наследники `DomainError`.

**Проверка.** Unit-тесты: хеш не зависит от порядка ключей, но зависит от значений; `dedupKeys` учитывает только указанные поля; `uuidV7ToDate(newUuidV7(t)) === t` для набора значений, включая границы; round-trip курсора; невалидный курсор бросает `InvalidCursorError`; конфиг типов возвращает переопределения. Покрытие этих файлов — 100%.

**Сообщение.** `feat(notifications): добавить доменные примитивы (uuidv7, dedup-хеш, конфиг типов, DTO)`

---

### Коммит 07 — Создание уведомления: атомарные дедуп и rate limit

**Цель.** Ядро задания (R5 + R6 + R3) — одна транзакция из раздела 3.4.

**Файлы.** `src/notifications/notifications.repository.ts`, `notifications.service.ts`, `notifications.module.ts`, `test/unit/notifications.service.spec.ts`, `test/integration/notifications-create.spec.ts`.

**Реализация.**

- `NotificationsRepository` — **весь SQL здесь**, каждый метод принимает транзакцию: `acquireUserTypeLock(trx, userId, type)` (возвращает и `now` из `clock_timestamp()`), `findDedupAnchor(...)`, `incrementOccurrences(...)`, `countInRateWindow(...)`, `insert(...)`.
- `NotificationsService.create(input)` — реализует последовательность из 3.4 внутри `withTransaction`, возвращает discriminated union `{ status: 'created' | 'deduplicated', notification }`, при превышении бросает `RateLimitExceededError` с `retryAfterMs`, `limit`, `windowMs`.
- Возвращать домен-объект, а не строку БД (маппер из 06).
- Никакого WS здесь: сервис публикует событие `notification.created` во внутренний `EventEmitter2` **после** коммита (подписчик появится в 13). Такое разделение объяснить в TSDoc.
- Логи: одна структурная запись на исход (`created` / `deduplicated` / `rate_limited`) с `userId`, `type`, `notificationId`, `durationMs`.

**Проверка (integration, реальный Postgres).**

1. дубль в пределах 5 минут → одна строка, `occurrences = 2`, `last_seen_at` обновлён, ответ `deduplicated`;
2. дубль после окна (сдвиг времени через изменение `created_at` якоря) → создаётся вторая строка;
3. разный `payload` при одинаковом типе → две строки; при `dedupKeys` — одна;
4. 10 уведомлений проходят, 11-е в том же окне → `RateLimitExceededError` с корректным `retryAfterMs`;
5. лимит независим для разных типов и разных пользователей;
6. **гонки:** `Promise.all` из 20 одинаковых запросов → ровно одна строка, `occurrences = 20`;
7. **гонки на лимите:** `Promise.all` из 30 разных запросов одного типа → ровно 10 строк;
8. схлопывание дубля не сбрасывает `read_at` и не считается в rate-limit-окне;
9. rollback при ошибке не оставляет строк и advisory-локов.

**Сообщение.** `feat(notifications): реализовать создание с атомарным схлопыванием дублей и лимитом`

---

### Коммит 08 — Чтение: пометка прочитанным и список непрочитанных

**Цель.** Закрыть остальные два метода R1 запросами, которые не деградируют на 100M+ строк.

**Файлы.** дополнения в `notifications.repository.ts`, `notifications.service.ts`, `test/integration/notifications-read.spec.ts`.

**Реализация.**

- `markAsRead(userId, id)`: `created_at` выводится из UUIDv7 → `UPDATE … WHERE id = $1 AND created_at = $2 AND user_id = $3 AND read_at IS NULL RETURNING *`; если 0 строк — отдельным `SELECT` различить «уже прочитано» (вернуть текущее состояние, идемпотентно) и «не существует / чужое» (`NotificationNotFoundError` → 404, одинаковый ответ для чужого и отсутствующего, чтобы не давать перебор id).
- `markAllAsRead(userId)`: `UPDATE … WHERE user_id = $1 AND read_at IS NULL` с ограничением по времени (`created_at > now() - retention`) и возвратом количества; для очень больших объёмов — чанками по 10 000 в цикле, чтобы не держать длинную транзакцию (объяснить в TSDoc).
- `listUnread(userId, limit, cursor)`: keyset по `(created_at DESC, id DESC)`, `LIMIT limit + 1` для вычисления `nextCursor`. Никакого `OFFSET` — обосновать в комментарии.
- `countUnread(userId, cap = 1000)`: `SELECT count(*) FROM (SELECT 1 … LIMIT cap + 1) t` → `{ count, exact }`, чтобы бейдж «999+» не стоил полного сканирования.
- Публиковать событие для WS-синхронизации прочтения (подписчик в 13).

**Проверка.** Integration: пагинация без пропусков и дублей при вставках между страницами; повторный `markAsRead` идемпотентен; чужое уведомление → 404; `countUnread` отдаёт `exact: false` при превышении cap; `EXPLAIN ANALYZE` подтверждает использование `notifications_unread_idx` и одну партицию в `markAsRead` (assert в тесте по плану запроса).

**Сообщение.** `feat(notifications): добавить пометку прочитанным и keyset-выборку непрочитанных`

---

### Коммит 09 — REST-контроллер и Swagger

**Цель.** Публичный HTTP-контракт из 4.1 + e2e.

**Файлы.** `src/notifications/notifications.controller.ts`, `src/notifications/dto/*` (response-DTO), `test/e2e/notifications.e2e-spec.ts`, `docs/api.md`.

**Реализация.**

- Эндпоинты `POST /notifications`, `GET /notifications/unread`, `GET /notifications/unread/count`, `PATCH /notifications/:id/read`, `POST /notifications/read-all`.
- `@ApiOperation` + `@ApiResponse` на **каждый** ответ, включая 422 и 429; примеры тел запроса/ответа; `@ApiHeader('Idempotency-Key')` (реализация в 11).
- Маппинг `RateLimitExceededError` → 429 + заголовки `RateLimit-*`/`Retry-After` (интерцептор или расширение фильтра ошибок).
- `POST` возвращает 201 при создании и **200** при схлопывании — семантически разные исходы, задокументировать.
- Контроллер тонкий: валидация → сервис → маппер. Никакой логики.
- `docs/api.md`: таблица эндпоинтов + готовые `curl`-примеры (копируются ревьюером напрямую).

**Проверка.** e2e через Supertest: счастливые пути, 422 на мусорном вводе (лишнее поле, не-UUID, payload > лимита, битый курсор), 429 после 10 запросов с корректными заголовками, 404 на чужом id; snapshot OpenAPI-схемы, чтобы контракт не менялся молча.

**Сообщение.** `feat(api): добавить REST-эндпоинты уведомлений со Swagger и e2e`

---

### Коммит 10 — Аутентификация (dev-JWT) для HTTP и WebSocket

**Цель.** Пользователь берётся из токена, а не из тела запроса; один механизм для REST и WS.

**Файлы.** `src/auth/auth.module.ts`, `auth.service.ts`, `auth.controller.ts`, `jwt.strategy.ts` (или собственный верификатор), `guards/http-auth.guard.ts`, `guards/ws-auth.guard.ts`, `decorators/current-user.decorator.ts`, `test/e2e/auth.e2e-spec.ts`.

**Реализация.**

- Две роли в токене: `user` (может читать/помечать только свои уведомления) и `service` (продюсер, может создавать уведомления любому `userId`). Это снимает вопрос ревьюера «почему клиент может создать уведомление другому».
- `POST /auth/dev-token { userId?, role? }` — выдаёт JWT; **регистрируется только при `AUTH_DEV_TOKENS_ENABLED=true`**, в проде эндпоинта нет вовсе (не «403», а отсутствует). Нужен для демо-страницы.
- `HttpAuthGuard` — глобальный, публичные маршруты помечаются `@Public()` (health, metrics, docs, dev-token).
- `WsAuthGuard` + верификация в `handshake.auth.token` — общий код с HTTP (один `TokenVerifier`), чтобы не было двух реализаций.
- В `POST /notifications`: если токен роли `user`, `userId` из тела обязан совпадать с токеном (иначе 403); роль `service` — без ограничений. Правило описать в Swagger.
- `@CurrentUser()` — декоратор, отдающий типизированный `AuthenticatedActor`.

**Проверка.** e2e: без токена → 401; чужой `userId` под ролью `user` → 403; истёкший токен → 401 с `problem+json`; при `AUTH_DEV_TOKENS_ENABLED=false` маршрут `dev-token` → 404.

**Сообщение.** `feat(auth): добавить dev-JWT и общие guard-ы для HTTP и WebSocket`

---

### Коммит 11 — Idempotency-Key для создания уведомлений

**Цель.** Ретрай продюсера (таймаут сети, at-least-once очередь) не создаёт вторую сущность. Это **не** то же самое, что дедуп из R6: дедуп — бизнес-правило по содержимому, идемпотентность — транспортная гарантия по ключу.

**Файлы.** `migrations/…_idempotency-keys.sql`, `src/notifications/idempotency/*`, `test/integration/idempotency.spec.ts`, `docs/adr/0006-idempotency-vs-dedup.md`.

**Реализация.**

```sql
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
```

- Интерцептор: при наличии `Idempotency-Key` — `INSERT … ON CONFLICT DO NOTHING`; если ключ уже есть и `request_hash` совпадает — вернуть сохранённый ответ с заголовком `Idempotent-Replay: true`; если хеш отличается — `409` (тот же ключ с другим телом).
- Параллельный повтор (ключ вставлен, ответа ещё нет) → `409` с `Retry-After: 1`, задокументировать как осознанный компромисс против блокирующего ожидания.
- TTL 24 часа, cron-очистка `expires_at < now()` (чанками).

**Проверка.** Integration: повтор с тем же ключом и телом → тот же ответ, в БД одна строка уведомления; тот же ключ + другое тело → 409; после истечения TTL и очистки ключ переиспользуем.

**Сообщение.** `feat(api): поддержать Idempotency-Key при создании уведомлений`

---

### Коммит 12 — WebSocket-шлюз: подключения, авторизация, presence

**Цель.** Аутентифицированные соединения, комнаты по пользователю, наблюдаемый presence. Без бизнес-доставки (она в 13).

**Файлы.** `src/realtime/realtime.module.ts`, `notifications.gateway.ts`, `presence.registry.ts`, `ws-exception.filter.ts`, `dto/ws-*.ts`, `test/e2e/gateway-connection.e2e-spec.ts`.

**Реализация.**

- `@WebSocketGateway({ namespace: '/ws/notifications', transports: ['websocket','polling'], pingInterval, pingTimeout, maxHttpBufferSize })` — все значения из конфига.
- `handleConnection`: верификация токена (общий `TokenVerifier` из 10); при провале — `socket.emit('connect_error'…)`/`disconnect(true)` с кодом причины. Успех → `socket.join('user:' + userId)`, регистрация в `PresenceRegistry`, отправка `connection.ready` с `unreadCount`.
- `handleDisconnect`: снятие с учёта, лог с причиной и длительностью сессии.
- `PresenceRegistry` — интерфейс (`add`, `remove`, `isOnline`, `onlineUserIds`, `socketCount`) + in-memory реализация; в 15 появится Redis-реализация без изменения потребителей.
- WS-фильтр исключений: доменные ошибки → `{ error: { code, message } }` в ack, а не разрыв соединения; неожидаемые — лог + generic-ошибка.
- Zod-валидация всех входящих payload-ов (`@nestjs/websockets` не применяет HTTP-пайпы к ack-callback-ам так же — сделать явный `WsValidationPipe`).
- Ограничение числа соединений на пользователя (например 10) — защита от утечки сокетов.

**Проверка.** e2e с `socket.io-client`: подключение с валидным токеном → `connection.ready`; без токена/с мусорным → отказ; после `disconnect` пользователь исчезает из presence; 11-е соединение отклоняется.

**Сообщение.** `feat(realtime): добавить Socket.IO-шлюз с авторизацией и реестром присутствия`

---

### Коммит 13 — Доставка в реальном времени с подтверждениями

**Цель.** R7 — уведомление появляется у онлайн-клиента мгновенно, `delivered_at` ставится только по ack.

**Файлы.** `src/realtime/delivery.dispatcher.ts`, дополнения в `notifications.gateway.ts`, `notifications.repository.ts` (`markDelivered`), `test/e2e/realtime-delivery.e2e-spec.ts`.

**Реализация.**

- `DeliveryDispatcher` слушает событие домена (после коммита), проверяет presence и делает `server.to('user:'+userId).timeout(ackTimeoutMs).emitWithAck('notification.created', dto)`.
- По успешному ack → `markDelivered([id])` (`UPDATE … WHERE (id, created_at) IN … AND delivered_at IS NULL`, `created_at` выводится из id). Таймаут/ошибка → **не** ставить `delivered_at`, залогировать, оставить sweeper-у (14). Это и есть at-least-once; в TSDoc объяснить, почему выбран at-least-once, а не at-most-once.
- Батчинг `markDelivered`: копить id в буфере и писать пачками (окно 50 мс / 100 id), чтобы 300 RPS не превратились в 300 отдельных UPDATE. Флашить буфер на `onApplicationShutdown`.
- Обработчики `notification.ack`, `notification.read` (broadcast `notification.read` во все сокеты пользователя — синхронизация вкладок), `notification.fetchUnread`.
- Метрики-хуки (счётчики реализуются в 17): `delivered`, `ack_timeout`, `push_skipped_offline`.

**Проверка.** e2e: онлайн-клиент получает уведомление < 200 мс после `POST`; после ack `delivered_at` заполнен; клиент, не ответивший ack (`autoAck: false`), оставляет `delivered_at = NULL`; схлопнутый дубль **не** порождает второй push; `notification.read` из одной вкладки прилетает в другую.

**Сообщение.** `feat(realtime): доставлять уведомления онлайн-клиентам с подтверждением ack`

---

### Коммит 14 — Догон недоставленного: офлайн-сценарий и sweeper

**Цель.** R9 + вторая половина R3: ничего не теряется, даже если инстанс упал между коммитом и push.

**Файлы.** `src/realtime/backlog.replayer.ts`, `undelivered.sweeper.ts`, дополнения в репозитории (`listUndelivered`, `listUndeliveredForUsers`), `test/e2e/offline-backlog.e2e-spec.ts`.

**Реализация.**

- `BacklogReplayer.replay(socket)` вызывается после `connection.ready`: постранично (`WS_BACKLOG_BATCH_SIZE`, по умолчанию 100) выбирает `delivered_at IS NULL` по возрастанию `created_at`, отправляет `notification.backlog` c `emitWithAck`, по ack — `markDelivered(batchIds)`, следующая страница — только после успешного ack (backpressure: медленный клиент не получит 100k событий в буфер).
- Жёсткие лимиты: максимум страниц за одно подключение и общий лимит; если backlog огромный — отдать первые N и выставить `hasMore: true`, клиент дотягивает через `notification.fetchUnread`. Обосновать в TSDoc.
- Реплей выполняется в фоне и не блокирует `handleConnection`; при `disconnect` посреди реплея — корректная отмена (проверять `socket.connected` перед каждой страницей).
- `UndeliveredSweeper` — интервал `SWEEPER_INTERVAL_MS` (по умолчанию 15 с): берёт онлайн-пользователей из presence, выбирает их `delivered_at IS NULL` старше 30 с и допушивает. Это ловит: падение инстанса после коммита, потерянные ack-и, доставку от инстанса, который не держит сокет (в связке с 15).
- Идемпотентность на клиенте: в событии всегда полный объект с `id`, повтор безопасен; в `docs/api.md` — явное требование к клиентам дедуплицировать по `id`.

**Проверка.** e2e-сценарии:

1. клиент отключён → 3 `POST` → клиент подключается → получает все 3 в `notification.backlog` в порядке `created_at`;
2. частичный ack: клиент подтверждает первую партию и рвёт соединение → при следующем подключении приходят только неподтверждённые;
3. клиент онлайн, но push «сломан» (замокан провал `emitWithAck`) → sweeper дожимает в течение интервала;
4. backlog > лимита → `hasMore: true` и корректная дотяжка через `fetchUnread`.

**Сообщение.** `feat(realtime): догонять недоставленные уведомления при подключении и через sweeper`

---

### Коммит 15 — Горизонтальное масштабирование через Redis-адаптер (опционально включаемое)

**Цель.** Показать, что архитектура масштабируется на несколько инстансов, не ломая одноинстансный запуск.

**Файлы.** `src/realtime/adapters/redis-io.adapter.ts`, `src/realtime/presence.redis.ts`, `docker-compose.scale.yml`, `deploy/nginx-ws.conf` (или Caddy-конфиг), `docs/adr/0007-scaling-websockets.md`, `test/integration/redis-presence.spec.ts`.

**Реализация.**

- Если `REDIS_URL` задан: `@socket.io/redis-adapter` + Redis-реализация `PresenceRegistry` (`SADD/SREM` с TTL и периодическим refresh, чтобы «зависшие» записи умирали сами). Если не задан — прежнее in-memory поведение, никаких падений.
- `docker-compose.scale.yml`: 2 реплики API + Redis + reverse-proxy с корректным проксированием WebSocket (`Upgrade`, `Connection`, увеличенные таймауты); в документации — почему при использовании только `transports: ['websocket']` sticky-сессии не обязательны, а при polling-фолбэке нужны.
- Sweeper из 14 при нескольких инстансах: лок `pg_try_advisory_lock`, чтобы не дублировать работу; push идёт через Redis-адаптер на тот инстанс, где живёт сокет.

**Проверка.** Integration с реальным Redis (testcontainers): клиент подключён к инстансу A, `POST` уходит в инстанс B → клиент получает уведомление; presence виден обоим инстансам; при `REDIS_URL` пустом все прежние тесты по-прежнему зелёные.

**Сообщение.** `feat(realtime): поддержать несколько инстансов через Redis-адаптер Socket.IO`

---

### Коммит 16 — Тестовая страница (R8)

**Цель.** Ревьюер открывает один URL и за минуту видит **все** требования в действии.

**Файлы.** `public/demo/index.html`, `app.js`, `styles.css`, подключение `ServeStaticModule` (или `useStaticAssets`) на `/demo`, `docs/demo.md`, скриншоты в `docs/assets/`.

**Реализация.** Без сборщика (чистые ESM + Socket.IO client из CDN c локальным фолбэком), тёмная аккуратная вёрстка, три колонки:

1. **Сессия.** Поле `userId` (кнопка «сгенерировать UUID»), «Получить dev-токен», индикатор соединения (`connected / reconnecting / offline`), кнопки **Disconnect** / **Connect** — главный инструмент проверки офлайн-сценария, рядом подпись «отключитесь, отправьте уведомления, подключитесь снова».
2. **Форма отправки** (R8). Поля: `userId` получателя (по умолчанию свой), `type` (select из конфига типов + свободный ввод), `payload` (textarea с JSON, валидация на лету и подсветка ошибки), «отправить N раз» (1/3/15) и интервал — чтобы в один клик демонстрировать **и** схлопывание дублей, **и** срабатывание лимита. Плюс чекбокс `Idempotency-Key` и кнопка «повторить последний запрос с тем же ключом».
3. **Результат.** Живая лента WS-событий (badge `live` / `backlog` / `sweeper`), список непрочитанных с кнопками «прочитано» и «прочитать все», счётчик непрочитанных, сырой лог всех HTTP-ответов с кодами (видно 201 / 200 `deduplicated` / 429 с `Retry-After`), панель со счётчиками сессии: получено / схлопнуто / отклонено лимитом / доставлено из backlog.

- Клиент дедуплицирует по `id` (`Map`), отвечает ack-ом, переподключается автоматически; в UI видно, что при `deduplicated` новое событие не приходит, а у существующего растёт `×N`.
- Внутри `app.js` — комментарии на каждую функцию (R10 распространяется и на демо-скрипт).
- `docs/demo.md` — сценарий проверки по шагам: «1) получить токен … 5) убедиться, что 11-й запрос вернул 429» + скриншоты/GIF.

**Проверка.** Вручную по чек-листу из `docs/demo.md` (все 5 сценариев) + smoke-тест, что `GET /demo` возвращает 200 и не требует авторизации; CSP в helmet настроен так, что страница действительно работает (частая ошибка — забыть про CDN в CSP).

**Сообщение.** `feat(demo): добавить тестовую страницу с формой отправки и живой лентой`

---

### Коммит 17 — Наблюдаемость: метрики Prometheus

**Цель.** Утверждения про 500k/сутки должны быть измеримыми, а не декларативными.

**Файлы.** `src/observability/metrics.module.ts`, `metrics.service.ts`, `metrics.controller.ts`, интерцептор HTTP-метрик, `docs/observability.md`, `deploy/grafana-dashboard.json` (опц.), `test/e2e/metrics.e2e-spec.ts`.

**Реализация.**

- Счётчики: `notifications_created_total{type}`, `notifications_deduplicated_total{type}`, `notifications_rate_limited_total{type}`, `notifications_delivered_total{path="live|backlog|sweeper"}`, `notifications_ack_timeout_total`.
- Гистограммы: `notification_create_duration_seconds`, `db_query_duration_seconds{query}`, `http_request_duration_seconds{route,status}`.
- Gauge: `ws_connected_sockets`, `ws_online_users`, `notifications_undelivered_backlog` (периодический дешёвый `count` с cap), `db_pool_{total,idle,waiting}`.
- Дефолтные метрики процесса; `/metrics` — публичный, но отключаемый `METRICS_ENABLED` (в `docs/deployment.md` — как закрыть его в проде).
- Строго следить за кардинальностью лейблов: `type` — только из белого списка конфига, иначе `other` (иначе произвольный `type` от продюсера взорвёт метрики; это же — хороший комментарий в коде).

**Проверка.** e2e: после сценария «создать/схлопнуть/упереться в лимит» соответствующие счётчики в `/metrics` имеют ожидаемые значения.

**Сообщение.** `feat(observability): добавить метрики Prometheus по всем ключевым сценариям`

---

### Коммит 18 — Доказательство durability при рестарте (R3)

**Цель.** Не рассказывать, что данные не теряются, а показать это автоматизированным тестом.

**Файлы.** `test/reliability/restart-durability.spec.ts`, `test/reliability/README.md`, `scripts/chaos-restart.sh`.

**Реализация.**

- Сценарий: подключить WS-клиента с отключённым авто-ack → генерировать поток `POST` (например 500 запросов) → в середине потока **жёстко** убить процесс приложения (`SIGKILL`, не graceful) → перезапустить → подключить клиента заново.
- Проверять: (а) все запросы, получившие `2xx`, присутствуют в БД ровно один раз; (б) все они в итоге доходят до клиента (backlog + sweeper); (в) `occurrences`-суммы совпадают с ожидаемыми; (г) нет строк в неконсистентном состоянии (`delivered_at` без ack и т.п.).
- Дополнительно: рестарт **Postgres** во время потока → приложение переживает (пул восстанавливается, `/health/ready` мигает 503 и возвращается в 200), запросы в момент падения получают 5xx (честно), но подтверждённые данные целы.
- Тест помечен отдельным jest-проектом (`reliability`), в CI запускается в отдельной job (медленный), локально — `make test:reliability`.
- В `test/reliability/README.md` — что именно доказывает тест и как читать его вывод (это читает ревьюер).

**Проверка.** `pnpm test:reliability` зелёный дважды подряд (проверка на флейки).

**Сообщение.** `test(reliability): доказать сохранность уведомлений при жёстком рестарте`

---

### Коммит 19 — Нагрузочное тестирование и обоснование 500k/день (R4)

**Цель.** Цифры в README, полученные измерением, а не оценкой.

**Файлы.** `load/create-notifications.js` (k6), `load/mixed-workload.js`, `load/ws-fanout.js`, `docker-compose.load.yml`, `docs/performance.md`, `scripts/explain-report.sh`.

**Реализация.**

- k6-сценарии: (1) чистое создание с уникальными payload-ами, ramp 50 → 300 RPS; (2) смешанный профиль 70% create / 20% unread / 10% read; (3) 1000 одновременных WS-клиентов + fanout; (4) стресс до отказа — найти реальный предел и точку деградации.
- Пороги (`thresholds`) в самих скриптах: `http_req_failed < 1%`, `p(95) < 50ms` для create, `p(99) < 200ms`.
- `docs/performance.md`: конфигурация стенда (CPU/RAM/диск, версии), таблица результатов (RPS, p50/p95/p99, CPU, размер БД, рост за прогон), пересчёт в «сутки» и запас относительно требуемых 5.8 RPS, `EXPLAIN (ANALYZE, BUFFERS)` для трёх ключевых запросов с подтверждением partition pruning и index-only scan там, где ожидается, график/таблица роста при 500k строках в партиции.
- Раздел «Что делать дальше при росте ×10/×100»: Redis-счётчики лимитов, вынос fanout в BullMQ, read-replica для списков, партиции по неделям, `pgBouncer`, шардирование по `user_id`. Коротко, по делу, с указанием сигнала-триггера для каждого шага.
- `scripts/explain-report.sh` — генерирует свежие планы запросов на заполненной БД (воспроизводимо ревьюером).

**Проверка.** `make load` проходит с соблюдением thresholds; числа в `docs/performance.md` соответствуют выводу k6 (приложить исходный вывод в `docs/performance/raw/`).

**Сообщение.** `perf: добавить нагрузочные сценарии k6 и отчёт о пропускной способности`

---

### Коммит 20 — Продакшн-хардненинг

**Цель.** Убрать всё, за что могут снизить оценку: незакрытые лимиты, отсутствие таймаутов, root в контейнере.

**Файлы.** правки `main.ts`, `Dockerfile`, `src/common/*`, `src/realtime/*`, `docs/security.md`.

**Реализация.**

- HTTP: `@nestjs/throttler` на весь API (защита от флуда самим API — это другой уровень, чем бизнес-лимит R5; разницу объяснить в комментарии), body-limit (например 64 КБ), таймаут запроса, `helmet` с осознанной CSP, отключённый `x-powered-by`, `trust proxy` для корректных IP за Caddy.
- WS: `maxHttpBufferSize`, лимит событий в секунду на сокет, лимит сокетов на пользователя (из 12), закрытие «молчащих» соединений.
- БД: `statement_timeout`, `lock_timeout`, `idle_in_transaction_session_timeout`, проверка `DB_POOL_MAX × инстансы < max_connections` на старте с предупреждением.
- Graceful shutdown полностью: перестать принимать HTTP → закрыть WS c кодом «сервер перезагружается» (клиенты сами переподключатся) → дождаться незавершённых транзакций (с таймаутом) → флашнуть буфер `markDelivered` → закрыть пул.
- Контейнер: non-root, `read_only: true` + `tmpfs` для `/tmp`, `cap_drop: [ALL]`, `no-new-privileges`, лимиты `cpus`/`memory`, `restart: unless-stopped`.
- Секреты: только через env/секреты Docker, `JWT_SECRET` минимум 32 байта (проверка в Zod), в проде запрет дефолтных значений (fail fast).
- `docs/security.md`: модель угроз коротко (кто может создать уведомление, что видит клиент, что логируется, где PII, почему payload не индексируется целиком).

**Проверка.** `pnpm test` зелёный; `docker compose kill -s SIGTERM api` → в логах видна корректная последовательность завершения без «unhandled rejection»; запуск с дефолтным `JWT_SECRET` и `NODE_ENV=production` падает на старте.

**Сообщение.** `chore(security): усилить лимиты, таймауты и корректное завершение процесса`

---

### Коммит 21 — Развёртывание на тестовом сервере (R11)

**Цель.** Публичный HTTPS/WSS-URL, воспроизводимый деплой одной командой.

**Файлы.** `deploy/docker-compose.prod.yml`, `deploy/Caddyfile`, `deploy/deploy.sh`, `deploy/backup.sh`, `deploy/.env.prod.example`, `.github/workflows/release.yml`, `docs/deployment.md`, `scripts/smoke-test.sh`.

**Реализация.**

- `docker-compose.prod.yml`: образ из GHCR по тегу (не `latest`), one-shot `migrate`, `api` (без публикации порта наружу), `caddy` (80/443, авто-TLS Let's Encrypt, reverse-proxy с поддержкой WebSocket, gzip, security-заголовки), `postgres` с именованным volume и настройками под VPS (`shared_buffers`, `work_mem`, `max_connections`), опциональный `redis` под профилем.
- `release.yml`: сборка multi-arch образа, публикация в GHCR по тегу `v*`, генерация SBOM (опц.), запуск `deploy.sh` через SSH-секреты **или** инструкция для ручного запуска (выбрать один путь и описать).
- `deploy.sh`: идемпотентный — `pull` → `migrate` (падение миграции = стоп деплоя) → перезапуск `api` → ожидание `/health/ready` → `smoke-test.sh` → при провале откат на предыдущий тег. Логи шагов человекочитаемые.
- `backup.sh` + cron: `pg_dump -Fc` с ротацией (7 дней), проверка восстановления описана в `docs/deployment.md` (бэкап без проверенного restore не считается бэкапом).
- `smoke-test.sh`: получить dev-токен → создать уведомление → проверить, что оно в непрочитанных → подключиться по `wss://` и получить событие → пометить прочитанным. Один скрипт, который ревьюер может запустить сам против прода.
- `docs/deployment.md`: требования к серверу (2 vCPU / 4 ГБ — обосновать по результатам 19), пошаговая подготовка VPS, DNS, первый деплой, обновление, откат, где смотреть логи и метрики, чек-лист «что проверить после деплоя».

**Проверка.** Реальный деплой; `smoke-test.sh` против публичного домена зелёный; демо-страница открывается по HTTPS и WS работает через `wss://` (проверить в консоли браузера — нет mixed content); `docker compose restart api` не приводит к потере уведомлений (повторить сценарий из 18 против прода).

**Сообщение.** `feat(deploy): добавить прод-compose с Caddy TLS, скрипт деплоя и бэкапы`

---

### Коммит 22 — Полный CI и матрица тестов

**Цель.** Каждый PR прогоняет всё; ревьюер видит зелёный бейдж.

**Файлы.** `.github/workflows/ci.yml` (расширение), `jest.config.ts` (projects), `codecov`/coverage-конфиг, бейджи в README.

**Реализация.**

- Jest-проекты: `unit` (быстрые, без БД), `integration` (testcontainers), `e2e` (полное приложение), `reliability` (отдельная job, не блокирует PR, но запускается на `main`).
- CI jobs: `quality` (lint, typecheck, `db:types:check`, `prettier --check`), `test-unit`, `test-integration`, `test-e2e`, `build-image` (сборка + `docker compose up` + `smoke-test.sh` против поднятого стека), `reliability` (на `main`/по расписанию).
- Порог покрытия: ≥ 85% по строкам, 100% для `src/notifications/domain` и `src/common/utils`; падать при снижении.
- Кеширование pnpm-стора и слоёв Docker (buildx), `concurrency` для отмены устаревших прогонов.
- Бейджи CI и покрытия в README.

**Проверка.** Все job-ы зелёные на PR; искусственно сломанный тест валит нужную job; повторный прогон использует кеш (видно по времени).

**Сообщение.** `ci: настроить полную матрицу проверок и пороги покрытия`

---

### Коммит 23 — Документация: README, архитектура, ADR

**Цель.** Ревьюер за 5 минут понимает: что сделано, где это посмотреть, какие решения приняты и почему.

**Файлы.** `README.md` (полный), `docs/architecture.md`, `docs/adr/README.md` (индекс 0001–0009), `docs/testing.md`, `CHANGELOG.md`, `docs/assets/*` (скриншоты, GIF демо).

**Реализация. README (порядок разделов важен):**

1. Одно предложение о проекте + **ссылки: демо-страница, Swagger, метрики** (боевые URL).
2. Таблица «требование → как реализовано → где посмотреть/чем проверено» (раздел 0 этого плана, с ссылками на файлы и тесты).
3. Быстрый старт: `cp .env.example .env && make up` → три URL. Отдельно — `make test`, `make load`.
4. Архитектура: mermaid-диаграмма компонентов + sequence-диаграммы «создание уведомления» и «офлайн → реконнект».
5. Схема БД: диаграмма, объяснение партиционирования, индексов, UUIDv7.
6. Ключевые решения кратко (5–7 пунктов) со ссылками на ADR: Kysely вместо ORM; фиксированное окно дедупа; лимит в Postgres; at-least-once + ack; `commit → push` вместо очереди; Redis опционален.
7. Производительность: таблица из `docs/performance.md` + расчёт 500k/сутки и запас.
8. Протокол WebSocket: таблицы событий (раздел 4.2) + минимальный пример клиента на JS.
9. Переменные окружения: таблица (имя, тип, дефолт, назначение).
10. Тестирование: что покрыто, как запускать, что доказывает reliability-тест.
11. **Ограничения и что сделал бы дальше** — честный раздел: чего нет (шаблоны/i18n, каналы email/push, приоритеты, «прочитать все» без реального аудита, RBAC, мультиарендность), и как это встроилось бы. Такой раздел выгодно отличает senior-сдачу от «сделал по ТЗ».
12. Структура проекта + куда смотреть в первую очередь.

- Все ADR по единому шаблону: Контекст → Решение → Альтернативы (с причиной отказа) → Последствия (плюсы и минусы) → Триггер пересмотра.
- `docs/architecture.md` — потоки данных, границы модулей, что происходит при падении каждого компонента (таблица «отказ → поведение системы → как восстанавливается»).

**Проверка.** Прогнать README по шагам на чистой машине — всё работает как написано; проверить, что все ссылки живые (`lychee`/скрипт); ни одного «TODO» и ни одного расхождения с кодом.

**Сообщение.** `docs: описать архитектуру, решения и способы проверки требований`

---

### Коммит 24 — Финальная полировка и релиз v1.0.0

**Цель.** Сдать работу.

**Файлы.** `CHANGELOG.md`, `package.json` (версия), возможные мелкие правки.

**Реализация. Финальный чек-лист (пройти пунктом за пунктом, каждое «нет» — исправить):**

- [ ] Все 11 требований из таблицы трассировки закрыты и проверяемы.
- [ ] `pnpm lint && pnpm typecheck && pnpm test && pnpm test:e2e` — зелёные локально и в CI.
- [ ] `git clone` → `make up` на чистой машине работает без ручных шагов.
- [ ] Продакшн-URL живой: демо-страница, Swagger, `smoke-test.sh` зелёный.
- [ ] Каждый экспортируемый метод имеет TSDoc с «зачем» (проверить `pnpm lint` — правило включено, но глазами пробежать по 5 случайным файлам: комментарии осмысленные, а не «получает данные»).
- [ ] Нет секретов в истории git (`gitleaks`/`git log -p | grep`), `.env` в `.gitignore`.
- [ ] Нет `TODO`, `console.log`, закомментированного кода, неиспользуемых зависимостей (`depcheck`).
- [ ] Swagger-примеры реально работают (скопировать `curl` из `docs/api.md` и выполнить).
- [ ] История коммитов читается как рассказ: осмысленные заголовки, тела с обоснованием, никаких «fix», «wip», «asdf».
- [ ] `CHANGELOG.md` описывает v1.0.0 по возможностям.
- [ ] Тег `v1.0.0`, релиз в GitHub с ссылкой на демо.

**Сообщение.** `chore(release): выпустить v1.0.0`

---

## 6. Типичные ошибки, которых нельзя допустить

1. **Счётчики лимитов в памяти процесса** — обнуляются при рестарте, ломаются при двух инстансах. Только Postgres (или Redis как кеш поверх него).
2. **Дедуп через `SELECT` затем `INSERT` без блокировки** — гонка создаёт дубли. Только advisory lock (или уникальный индекс) в одной транзакции.
3. **Push в WebSocket внутри транзакции** — при откате клиент получит уведомление, которого нет в БД. Только после `COMMIT`.
4. **`delivered_at` по факту `emit`, а не по ack** — теряется всё, что ушло в разорванное соединение.
5. **`OFFSET`-пагинация** — деградирует и пропускает элементы при вставках. Только keyset.
6. **`count(*)` без cap для бейджа** — полное сканирование на больших объёмах.
7. **`userId` из тела запроса без сверки с токеном** — тривиальный IDOR.
8. **`UUIDv4` как PK** — случайные вставки в B-tree, потеря локальности и раздутие индексов на 182M строк.
9. **Партиционирование без автосоздания партиций** — через месяц вставки падают (либо всё оседает в `DEFAULT`).
10. **Комментарии-пересказ кода** (`// увеличиваем счётчик`) — требование R10 про **пояснения**: зачем, какие компромиссы, что сломается при изменении.
11. **Демо-страница, не показывающая 429 и схлопывание** — ревьюер не увидит главную часть задания. Форма обязана уметь «отправить 15 раз».
12. **CSP из helmet, ломающая демо-страницу** — проверить страницу именно в прод-конфигурации, а не только в dev.

---

## 7. Порядок работы, если время ограничено

Минимально достаточный набор для сдачи (в этом порядке): **00 → 04, 06 → 09, 12 → 14, 16, 21, 23**. Коммиты 05, 10, 11, 15, 17, 18, 19, 20, 22, 24 — то, что превращает «выполнено по ТЗ» в «senior-уровень»; отбрасывать их следует с конца списка и обязательно упоминать в разделе README «Ограничения и что дальше».
