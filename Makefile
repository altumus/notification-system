.PHONY: up down logs psql migrate seed test load deploy

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

seed:
	@echo "Seed будет добавлен позже"

test:
	pnpm test && pnpm test:integration

load:
	@echo "k6 сценарии появятся в коммите 19"

deploy:
	@echo "Railway: см. docs/deployment.md — затем: pnpm smoke https://YOUR-APP.up.railway.app"

smoke:
	pnpm smoke $(BASE_URL)
