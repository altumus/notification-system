# Демо-страница `/demo`

Публичная тестовая страница: REST + WebSocket без сборщика.

URL локально: `http://localhost:3000/demo/` (после `make up` / `pnpm dev`).

## Что видно сразу

1. **Сессия** — userId, dev-токен, Connect/Disconnect, счётчики.
2. **Отправка** — type/payload, «отправить N раз», Idempotency-Key.
3. **Результат** — непрочитанные, лента WS (`live` / `backlog`), HTTP-лог с кодами.

## Сценарии проверки (5 минут)

### 1) Токен и live-доставка

1. Нажмите **UUID** → **Получить dev-токен**.
2. **Connect** — badge `connected`.
3. Type `chat.message`, повторов `1` → **Отправить**.
4. В ленте WS — badge `live`, в непрочитанных появилась строка; HTTP-лог `201`.

### 2) Схлопывание дублей (R6)

1. Type `order.status_changed`, payload с одним `orderId`.
2. Повторов `3` → **Отправить**.
3. HTTP: первый `201`, следующие `200` + `deduplicated`.
4. В ленте **одно** событие; у непрочитанного растёт `×N` (occurrences).

### 3) Rate limit 10/мин (R5)

1. Type `chat.message`, повторов `15`, интервал `50–80` мс.
2. **Отправить**.
3. После десятого принятого — `429` и `Retry-After` в HTTP-логе; счётчик «лимит 429» растёт.

### 4) Офлайн → backlog (R9)

1. **Disconnect**.
2. Отправьте 3 уведомления (пока offline).
3. **Connect** — в ленте badge `backlog`, все три приходят по `created_at`.

### 5) Idempotency-Key

1. Включите чекбокс **Idempotency-Key**.
2. Отправьте один create → запомните ответ.
3. **Повторить с тем же ключом** → тот же body, заголовок replay / тот же результат без второго push.

## Замечания

- Клиент дедуплицирует WS-события по `id` (at-least-once от sweeper/backlog безопасен).
- Socket.IO: CDN `cdn.socket.io`, фолбэк `/demo/vendor/socket.io.esm.min.js`.
- Страница не требует Authorization; create идёт с ролью `service` из dev-токена.
