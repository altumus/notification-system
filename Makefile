.PHONY: up down logs psql migrate test test-all load load-peak load-stress load-read deploy smoke

up:
	docker compose up -d --build

down:
	docker compose down

logs:
	docker compose logs -f api

psql:
	docker compose exec postgres psql -U notifications -d notifications

migrate:
	pnpm migrate:up

test:
	pnpm test:unit && pnpm test:integration

test-all:
	pnpm test:unit && pnpm test:integration && pnpm test:e2e

# Нагрузочные профили. Требуют поднятого стенда (make up) и k6: https://k6.io/docs/get-started/installation/
load:
	pnpm load

load-peak:
	k6 run -e LOAD_PROFILE=peak load/create-notifications.js

load-stress:
	k6 run -e LOAD_PROFILE=stress load/create-notifications.js

load-read:
	pnpm load:read

deploy:
	@echo "Railway: см. docs/deployment.md — затем: pnpm smoke https://YOUR-APP.up.railway.app"

smoke:
	pnpm smoke $(BASE_URL)
