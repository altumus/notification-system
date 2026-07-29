#!/usr/bin/env sh
# Ждёт готовности API перед нагрузочным прогоном.
#
# Зачем: docker compose up возвращается раньше, чем приложение применит миграции и
# начнёт слушать порт; k6 без ожидания падает на первом запросе.
#
# Usage: ./scripts/wait-for-health.sh http://localhost:3001 90
set -eu

BASE_URL="${1:-http://localhost:3001}"
TIMEOUT_SEC="${2:-90}"
ELAPSED=0

echo "[wait-for-health] Ожидаю ${BASE_URL}/health/ready (таймаут ${TIMEOUT_SEC}s)"
while [ "$ELAPSED" -lt "$TIMEOUT_SEC" ]; do
  if curl -fsS -o /dev/null "${BASE_URL}/health/ready" 2>/dev/null; then
    echo "[wait-for-health] Готово за ${ELAPSED}s"
    exit 0
  fi
  sleep 2
  ELAPSED=$((ELAPSED + 2))
done

echo "[wait-for-health] FAIL: сервис не поднялся за ${TIMEOUT_SEC}s" >&2
exit 1
