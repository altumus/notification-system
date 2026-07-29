# HTTP API

Базовый префикс: `/api/v1`. Swagger UI: `/api/docs`.

До коммита 10 читающие операции принимают заголовок `X-User-Id` (UUID получателя).
Создание принимает `userId` в теле.

## Эндпоинты

| Метод   | Путь                          | Назначение                        |
| ------- | ----------------------------- | --------------------------------- |
| `POST`  | `/notifications`              | Создать (201) или схлопнуть (200) |
| `GET`   | `/notifications/unread`       | Непрочитанные + keyset            |
| `GET`   | `/notifications/unread/count` | Счётчик бейджа                    |
| `PATCH` | `/notifications/:id/read`     | Пометить прочитанным              |
| `POST`  | `/notifications/read-all`     | Прочитать все                     |

## curl

```bash
USER=11111111-1111-4111-8111-111111111111

# Создать
curl -s -X POST http://localhost:3001/api/v1/notifications \
  -H 'content-type: application/json' \
  -d "{\"userId\":\"$USER\",\"type\":\"chat.message\",\"payload\":{\"text\":\"hi\"}}"

# Непрочитанные
curl -s "http://localhost:3001/api/v1/notifications/unread?limit=20" \
  -H "X-User-Id: $USER"

# Счётчик
curl -s http://localhost:3001/api/v1/notifications/unread/count \
  -H "X-User-Id: $USER"

# Прочитать (подставьте id из create)
curl -s -X PATCH http://localhost:3001/api/v1/notifications/<id>/read \
  -H "X-User-Id: $USER"
```

Ошибки — `application/problem+json` (RFC 9457). При 429 выставляются `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset`, `Retry-After`.
