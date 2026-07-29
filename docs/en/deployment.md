# Deployment

**Язык / Language:** [Русский](../deployment.md) · English

## Local

Requirements: Docker, Docker Compose, Node.js 22, pnpm 10.

```bash
cp .env.example .env
make up
```

Verify:

- Liveness: http://localhost:3001/health/live
- Swagger: http://localhost:3001/api/docs
- Demo: http://localhost:3001/demo/

> Default host ports: API `3001→3000`, Postgres `5433→5432`. Inside compose — `postgres:5432` and `api:3000`.

Stop: `make down`.

---

## Railway (test stand, R11)

**Railway** is used instead of VPS+Caddy: one API service (Dockerfile) + PostgreSQL plugin provide public `https://` and `wss://` without manual TLS.

### Architecture on Railway

```
Internet → Railway Edge (HTTPS/WSS) → NestJS container
                                      ↳ DATABASE_URL → Railway Postgres
```

On container start: `migrations up` → `node dist/main.js` (`scripts/docker-entrypoint.sh`).

### 1. Create the project

1. [railway.app](https://railway.app) → **New Project** → **Deploy from GitHub repo** (this repository).
2. **Add Plugin** → **PostgreSQL** (same project).
3. API service: Settings → **Builder = Dockerfile** (picks up `railway.toml`).
4. Settings → **Networking** → **Generate Domain** (public `*.up.railway.app`).

### 2. Variables

API service Variables — see [`deploy/.env.railway.example`](../../deploy/.env.railway.example).

Required:

| Variable                  | Value                                                   |
| ------------------------- | ------------------------------------------------------- |
| `DATABASE_URL`            | Reference → Postgres → `DATABASE_URL` (do not hardcode) |
| `JWT_SECRET`              | `openssl rand -base64 48`                               |
| `NODE_ENV`                | `production`                                            |
| `AUTH_DEV_TOKENS_ENABLED` | `true` (for `/demo` and smoke)                          |
| `CORS_ORIGINS`            | `*` or your domain                                      |

Railway sets `PORT` automatically — do not set it manually.

### 3. Deploy

After a push to the linked branch Railway builds the image and deploys.

Or CLI:

```bash
npm i -g @railway/cli
railway login
railway link
railway up
```

### 4. Post-deploy checks

Stand base URL: `https://notification-system-production-0ee5.up.railway.app`

```bash
pnpm smoke https://notification-system-production-0ee5.up.railway.app
```

Manual checklist:

- [x] https://notification-system-production-0ee5.up.railway.app/health/live → 200
- [x] https://notification-system-production-0ee5.up.railway.app/api/docs — Swagger
- [x] https://notification-system-production-0ee5.up.railway.app/demo/ — demo over HTTPS
- [ ] In demo: scenarios A→E (WS = `wss://`, no mixed content)
- [x] `pnpm smoke` — ALL GREEN

### 5. Updates and rollback

- Update: merge/push to the deploy branch → new build.
- Rollback: Railway → Deployments → **Rollback** to the previous successful deploy.
- Logs: Railway → service → **Logs**.
- Postgres backup: Railway Postgres → backups / `pg_dump` via `railway connect` (verify restore on a copy — a backup without restore does not count).

### 6. Custom domain (optional)

Railway → Settings → Domains → Add Domain → DNS CNAME/ALIAS as in the UI. TLS is issued by Railway.

---

## Alternative: VPS + Docker Compose + Caddy

For full control (own VPS): run `docker compose` with Postgres + API behind Caddy (auto-TLS). For this assignment Railway is enough — public HTTPS/WSS URLs satisfy R11.

---

## Smoke test

```bash
# local (after make up)
pnpm smoke http://localhost:3001

# Railway stand
pnpm smoke https://notification-system-production-0ee5.up.railway.app
```

Script: [`scripts/smoke-test.mjs`](../../scripts/smoke-test.mjs).
