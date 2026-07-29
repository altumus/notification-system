# HTTP API

**Язык / Language:** Русский · [English](./en/api.md)

Базовый префикс: `/api/v1`. Swagger UI: `/api/docs`.

Аутентификация: `Authorization: Bearer <JWT>`. Токен содержит `sub` (userId) и `role` (`user` | `service`).

- Роль `user` — читает/помечает только свои уведомления; в `POST /notifications` поле `userId` обязано совпадать с токеном (иначе 403).
- Роль `service` — продюсер; может создавать уведомления любому `userId`.

Dev-токен (только при `AUTH_DEV_TOKENS_ENABLED=true`): `POST /api/v1/auth/dev-token` с телом `{ userId?, role? }`.

Опциональный заголовок `Idempotency-Key` на `POST /notifications` — транспортная идемпотентность (TTL 24ч, см. ADR-0006). Повтор с тем же ключом и телом возвращает сохранённый ответ и `Idempotent-Replay: true`; другой body → `409`; параллельный повтор → `409` + `Retry-After: 1`.

## Эндпоинты

| Метод   | Путь                          | Назначение                        |
| ------- | ----------------------------- | --------------------------------- |
| `POST`  | `/auth/dev-token`             | Выдать JWT (dev)                  |
| `POST`  | `/notifications`              | Создать (201) или схлопнуть (200) |
| `GET`   | `/notifications/unread`       | Непрочитанные + keyset            |
| `GET`   | `/notifications/unread/count` | Счётчик бейджа                    |
| `PATCH` | `/notifications/:id/read`     | Пометить прочитанным              |
| `POST`  | `/notifications/read-all`     | Прочитать все                     |

## curl

```bash
USER=11111111-1111-4111-8111-111111111111

# Dev-токен (роль service для create)
TOKEN=$(curl -s -X POST http://localhost:3001/api/v1/auth/dev-token \
  -H 'content-type: application/json' \
  -d "{\"userId\":\"$USER\",\"role\":\"service\"}" | jq -r .token)

# Создать
curl -s -X POST http://localhost:3001/api/v1/notifications \
  -H 'content-type: application/json' \
  -H "Authorization: Bearer $TOKEN" \
  -d "{\"userId\":\"$USER\",\"type\":\"chat.message\",\"payload\":{\"text\":\"hi\"}}"

# Непрочитанные (токен роли user того же USER)
USER_TOKEN=$(curl -s -X POST http://localhost:3001/api/v1/auth/dev-token \
  -H 'content-type: application/json' \
  -d "{\"userId\":\"$USER\",\"role\":\"user\"}" | jq -r .token)

curl -s "http://localhost:3001/api/v1/notifications/unread?limit=20" \
  -H "Authorization: Bearer $USER_TOKEN"

# Счётчик
curl -s http://localhost:3001/api/v1/notifications/unread/count \
  -H "Authorization: Bearer $USER_TOKEN"

# Прочитать (подставьте id из create)
curl -s -X PATCH http://localhost:3001/api/v1/notifications/<id>/read \
  -H "Authorization: Bearer $USER_TOKEN"
```

Ошибки — `application/problem+json` (RFC 9457). При 429 выставляются `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset`, `Retry-After`.

## WebSocket

Namespace: `/ws/notifications`. Подключение:

```js
io(URL + '/ws/notifications', { auth: { token }, transports: ['websocket'] });
```

| Направление | Событие                    | Смысл                                                    |
| ----------- | -------------------------- | -------------------------------------------------------- |
| S→C         | `connection.ready`         | Хендшейк ок, `unreadCount`                               |
| S→C         | `notification.created`     | Live-push; ответить ack `{ ok: true }`                   |
| S→C         | `notification.backlog`     | Догон при подключении: `{ items, batch, hasMore }` + ack |
| S→C         | `notification.read`        | Синхронизация вкладок                                    |
| C→S         | `notification.ack`         | Явное подтверждение `{ ids }`                            |
| C→S         | `notification.read`        | Пометить прочитанным                                     |
| C→S         | `notification.fetchUnread` | Дотяжка списка (если backlog обрезан по лимиту)          |

`delivered_at` ставится **только после ack** (at-least-once). Клиент **обязан дедуплицировать события по `id`**: sweeper/backlog могут повторить уже виденное уведомление.
