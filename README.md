# Notification System

API системы уведомлений на NestJS + PostgreSQL + WebSocket (Socket.IO).

## Стек

- Node.js 22 LTS, pnpm
- NestJS 11, PostgreSQL 17, Kysely
- Socket.IO, Docker Compose
- Деплой тестового стенда: **Railway**

## Быстрый старт (локально)

```bash
cp .env.example .env
make up
```

- Health: http://localhost:3001/health/live
- Swagger: http://localhost:3001/api/docs
- Демо: http://localhost:3001/demo/

## Railway

Пошагово: [docs/deployment.md](./docs/deployment.md#railway-тестовый-стенд-r11).

Кратко:

1. New Project from GitHub + Postgres plugin
2. Variables из [`deploy/.env.railway.example`](./deploy/.env.railway.example) + `DATABASE_URL` из Postgres
3. Generate Domain
4. Проверка: `pnpm smoke https://notification-system-production-0ee5.up.railway.app`

### Тестовый стенд

- Демо: https://notification-system-production-0ee5.up.railway.app/demo/
- Swagger: https://notification-system-production-0ee5.up.railway.app/api/docs
- Health: https://notification-system-production-0ee5.up.railway.app/health/live

## Документация

- [docs/deployment.md](./docs/deployment.md) — локально и Railway
- [docs/demo.md](./docs/demo.md) — сценарии демо-страницы
- [docs/api.md](./docs/api.md) — REST / WebSocket
