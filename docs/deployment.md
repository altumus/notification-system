# Развёртывание

**Язык / Language:** Русский · [English](./en/deployment.md)

## Локально

Требования: Docker, Docker Compose, Node.js 22, pnpm 10.

```bash
cp .env.example .env
make up
```

Проверка:

- Liveness: http://localhost:3001/health/live
- Swagger: http://localhost:3001/api/docs
- Демо: http://localhost:3001/demo/

> Хост-порты по умолчанию: API `3001→3000`, Postgres `5433→5432`. Внутри compose — `postgres:5432` и `api:3000`.

Остановка: `make down`.

---

## Railway (тестовый стенд, R11)

Выбран **Railway** вместо VPS+Caddy: один сервис API (Dockerfile) + плагин PostgreSQL дают публичный `https://` и `wss://` без ручного TLS.

### Архитектура на Railway

```
Internet → Railway Edge (HTTPS/WSS) → NestJS container
                                      ↳ DATABASE_URL → Railway Postgres
```

Контейнер при старте: `migrations up` → `node dist/main.js` (`scripts/docker-entrypoint.sh`).

### 1. Создать проект

1. [railway.app](https://railway.app) → **New Project** → **Deploy from GitHub repo** (этот репозиторий).
2. **Add Plugin** → **PostgreSQL** (в том же проекте).
3. Сервис API: Settings → **Builder = Dockerfile** (подхватит `railway.toml`).
4. Settings → **Networking** → **Generate Domain** (публичный `*.up.railway.app`).

### 2. Переменные

Variables сервиса API — см. [`deploy/.env.railway.example`](../deploy/.env.railway.example).

Обязательно:

| Variable                  | Значение                                              |
| ------------------------- | ----------------------------------------------------- |
| `DATABASE_URL`            | Reference → Postgres → `DATABASE_URL` (не хардкодить) |
| `JWT_SECRET`              | `openssl rand -base64 48`                             |
| `NODE_ENV`                | `production`                                          |
| `AUTH_DEV_TOKENS_ENABLED` | `true` (для `/demo` и smoke)                          |
| `CORS_ORIGINS`            | `*` или ваш домен                                     |

`PORT` Railway выставляет сам — не задавайте вручную.

### 3. Деплой

После push в подключённую ветку Railway соберёт образ и задеплоит.

Или CLI:

```bash
npm i -g @railway/cli
railway login
railway link
railway up
```

### 4. Проверка после деплоя

Базовый URL стенда: `https://notification-system-production-0ee5.up.railway.app`

```bash
pnpm smoke https://notification-system-production-0ee5.up.railway.app
```

Чеклист вручную:

- [x] https://notification-system-production-0ee5.up.railway.app/health/live → 200
- [x] https://notification-system-production-0ee5.up.railway.app/api/docs — Swagger
- [x] https://notification-system-production-0ee5.up.railway.app/demo/ — демо по HTTPS
- [ ] В демо: сценарии A→E (WS = `wss://`, без mixed content)
- [x] `pnpm smoke` — ALL GREEN

### 5. Обновление и откат

- Обновление: merge/push в ветку деплоя → новый build.
- Откат: Railway → Deployments → **Rollback** на предыдущий успешный деплой.
- Логи: Railway → сервис → **Logs**.
- Бэкап Postgres: Railway Postgres → backups / `pg_dump` через `railway connect` (проверьте restore на копии — бэкап без restore не считается).

### 6. Кастомный домен (опционально)

Railway → Settings → Domains → Add Domain → DNS CNAME/ALIAS как в UI. TLS выпускает Railway.

---

## Альтернатива: VPS + Docker Compose + Caddy

Если нужен полный контроль (свой VPS): поднять `docker compose` с Postgres + API за Caddy (авто-TLS). Для сдачи тестового задания достаточно Railway — публичные HTTPS/WSS URL те же по смыслу R11.

---

## Smoke-тест

```bash
# локально (после make up)
pnpm smoke http://localhost:3001

# стенд Railway
pnpm smoke https://notification-system-production-0ee5.up.railway.app
```

Скрипт: [`scripts/smoke-test.mjs`](../scripts/smoke-test.mjs).
