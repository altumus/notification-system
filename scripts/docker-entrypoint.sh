#!/bin/sh
# Entrypoint для Docker/Railway: миграции, затем Nest API.
# Зачем: без migrate up новый инстанс упадёт на отсутствующих таблицах.
set -eu

echo "[entrypoint] NODE_ENV=${NODE_ENV:-} PORT=${PORT:-3000}"
echo "[entrypoint] Applying migrations..."
./node_modules/.bin/node-pg-migrate up --config-file migrate.config.cjs
echo "[entrypoint] Starting API..."
exec node dist/main.js
