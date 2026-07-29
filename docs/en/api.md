# HTTP API

**Язык / Language:** [Русский](../api.md) · English

Base prefix: `/api/v1`. Swagger UI: `/api/docs`.

Auth: `Authorization: Bearer <JWT>`. The token carries `sub` (userId) and `role` (`user` | `service`).

- Role `user` — can read/mark only own notifications; in `POST /notifications`, `userId` must match the token (otherwise 403).
- Role `service` — producer; may create notifications for any `userId`.

Dev token (only when `AUTH_DEV_TOKENS_ENABLED=true`): `POST /api/v1/auth/dev-token` with body `{ userId?, role? }`.

Optional `Idempotency-Key` on `POST /notifications` — transport idempotency (24h TTL, see ADR-0006). Same key + same body returns the stored response and `Idempotent-Replay: true`; different body → `409`; concurrent retry → `409` + `Retry-After: 1`.

## Endpoints

| Method  | Path                          | Purpose                        |
| ------- | ----------------------------- | ------------------------------ |
| `POST`  | `/auth/dev-token`             | Issue JWT (dev)                |
| `POST`  | `/notifications`              | Create (201) or collapse (200) |
| `GET`   | `/notifications/unread`       | Unread list + keyset           |
| `GET`   | `/notifications/unread/count` | Badge counter                  |
| `PATCH` | `/notifications/:id/read`     | Mark as read                   |
| `POST`  | `/notifications/read-all`     | Mark all as read               |

## curl

```bash
USER=11111111-1111-4111-8111-111111111111

# Dev token (service role for create)
TOKEN=$(curl -s -X POST http://localhost:3001/api/v1/auth/dev-token \
  -H 'content-type: application/json' \
  -d "{\"userId\":\"$USER\",\"role\":\"service\"}" | jq -r .token)

# Create
curl -s -X POST http://localhost:3001/api/v1/notifications \
  -H 'content-type: application/json' \
  -H "Authorization: Bearer $TOKEN" \
  -d "{\"userId\":\"$USER\",\"type\":\"chat.message\",\"payload\":{\"text\":\"hi\"}}"

# Unread (user-role token for the same USER)
USER_TOKEN=$(curl -s -X POST http://localhost:3001/api/v1/auth/dev-token \
  -H 'content-type: application/json' \
  -d "{\"userId\":\"$USER\",\"role\":\"user\"}" | jq -r .token)

curl -s "http://localhost:3001/api/v1/notifications/unread?limit=20" \
  -H "Authorization: Bearer $USER_TOKEN"

# Count
curl -s http://localhost:3001/api/v1/notifications/unread/count \
  -H "Authorization: Bearer $USER_TOKEN"

# Mark read (use id from create)
curl -s -X PATCH http://localhost:3001/api/v1/notifications/<id>/read \
  -H "Authorization: Bearer $USER_TOKEN"
```

Errors use `application/problem+json` (RFC 9457). On 429 the API sets `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset`, `Retry-After`.

There are two kinds of 429, told apart by `problem.type`:

| `problem.type` (suffix) | When                                                                    | Client action                               |
| ----------------------- | ----------------------------------------------------------------------- | ------------------------------------------- |
| `rate-limit-exceeded`   | business limit `NOTIFICATIONS_RATE_LIMIT` per `(userId, type)` hit (R5) | wait for `Retry-After`; nothing was created |
| `too-many-requests`     | transport limit of requests from one IP to one endpoint hit             | slow down; see ADR-0008                     |

## WebSocket

Namespace: `/ws/notifications`. Connect:

```js
io(URL + '/ws/notifications', { auth: { token }, transports: ['websocket'] });
```

| Direction | Event                      | Meaning                                                |
| --------- | -------------------------- | ------------------------------------------------------ |
| S→C       | `connection.ready`         | Handshake OK, `unreadCount`                            |
| S→C       | `notification.created`     | Live push; reply with ack `{ ok: true }`               |
| S→C       | `notification.backlog`     | Catch-up on connect: `{ items, batch, hasMore }` + ack |
| S→C       | `notification.read`        | Cross-tab sync                                         |
| C→S       | `notification.ack`         | Explicit ack `{ ids }`                                 |
| C→S       | `notification.read`        | Mark as read                                           |
| C→S       | `notification.fetchUnread` | Fetch more if backlog was truncated                    |

`delivered_at` is set **only after ack** (at-least-once). The client **must deduplicate by `id`**: sweeper/backlog may redeliver a notification already seen.
