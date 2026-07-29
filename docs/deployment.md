# Развёртывание

## Локально

Требования: Docker, Docker Compose, Node.js 22, pnpm 10.

```bash
cp .env.example .env
make up
```

Проверка:

- Liveness: http://localhost:3001/health/live
- Swagger: http://localhost:3001/api/docs

> Хост-порты по умолчанию: API `3001→3000`, Postgres `5433→5432` (чтобы не конфликтовать с другими локальными Docker-стеками). Внутри сети compose сервисы ходят на `postgres:5432` и `api:3000`.

Остановка: `make down`.

Сервис `redis` поднимается только с профилем `scale`:

```bash
docker compose --profile scale up -d
```

Продакшн-compose и Caddy появятся в коммите 21.
