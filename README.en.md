# Notification System

**Язык / Language:** [Русский](./README.md) · English

Notification system API built with NestJS + PostgreSQL + WebSocket (Socket.IO).

## Stack

- Node.js 22 LTS, pnpm
- NestJS 11, PostgreSQL 17, Kysely
- Socket.IO, Docker Compose
- Test stand deploy: **Railway**

## Quick start (local)

```bash
cp .env.example .env
make up
```

- Health: http://localhost:3001/health/live
- Swagger: http://localhost:3001/api/docs
- Demo: http://localhost:3001/demo/

## Railway

Step-by-step: [docs/en/deployment.md](./docs/en/deployment.md#railway-test-stand-r11).

Short version:

1. New Project from GitHub + Postgres plugin
2. Variables from [`deploy/.env.railway.example`](./deploy/.env.railway.example) + `DATABASE_URL` from Postgres
3. Generate Domain
4. Verify: `pnpm smoke https://notification-system-production-0ee5.up.railway.app`

### Live stand

- Demo: https://notification-system-production-0ee5.up.railway.app/demo/
- Swagger: https://notification-system-production-0ee5.up.railway.app/api/docs
- Health: https://notification-system-production-0ee5.up.railway.app/health/live

## Documentation

Full index: **[docs/README.en.md](./docs/README.en.md)**

| Doc                    | Link                                                 |
| ---------------------- | ---------------------------------------------------- |
| API (REST / WebSocket) | [docs/en/api.md](./docs/en/api.md)                   |
| Demo scenarios         | [docs/en/demo.md](./docs/en/demo.md)                 |
| Deployment             | [docs/en/deployment.md](./docs/en/deployment.md)     |
| **ADRs**               | **[docs/adr/README.en.md](./docs/adr/README.en.md)** |

## Architecture decisions (ADR)

Why Kysely, partitions, dedup, rate limit, Railway, etc.:

→ **[Browse all ADRs](./docs/adr/README.en.md)**
