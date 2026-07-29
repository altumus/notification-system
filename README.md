# Notification System

API системы уведомлений на NestJS + PostgreSQL + WebSocket (Socket.IO).

## Стек

- Node.js 22 LTS, pnpm
- NestJS 11, PostgreSQL 17, Kysely
- Socket.IO, Docker Compose

## Статус

Проект в разработке. Полный план реализации — в [PLAN.md](./PLAN.md).

## Быстрый старт (3 команды)

```bash
cp .env.example .env
make up
# открыть http://localhost:3001/health/live и http://localhost:3001/api/docs
# (хост-порты 3001/5433, чтобы не конфликтовать с другими локальными стеками)
```

Подробности: [docs/deployment.md](./docs/deployment.md). Полный план — [PLAN.md](./PLAN.md).
