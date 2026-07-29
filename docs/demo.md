# Демо-страница `/demo`

**Язык / Language:** Русский · [English](./en/demo.md)

Публичная тестовая страница: REST + WebSocket без сборщика.

URL локально: `http://localhost:3000/demo/` (после `make up` / `pnpm dev`).  
Стенд: https://notification-system-production-0ee5.up.railway.app/demo/

## Как пользоваться

1. **Подготовиться** — выдаёт userId, dev-токен и подключает WebSocket.
2. Жмите сценарии **A → E** по порядку. Справа смотрите ленту WS и HTTP-лог.
3. HTTP-лог показывает смысл ответа («Создано», «Схлопнуто», «Лимит 429»); клик по строке раскрывает JSON.
4. В блоке **Сессия** — таймер rate-limit: после 429 считает секунды до снятия окна (из `Retry-After`).
5. **Ручная отправка** — type/payload, burst, preview Idempotency-Key.

## Сценарии

| Кнопка            | Что делает                  | Что ожидать                                 |
| ----------------- | --------------------------- | ------------------------------------------- |
| **A Live**        | 1 × `chat.message` онлайн   | HTTP «Создано» (201), в ленте `live`        |
| **B Dedup**       | один заказ ×3               | 201, затем два «Схлопнуто»; одно событие ×3 |
| **C Rate limit**  | 15 разных сообщений         | после ~10 — «Лимит превышен (429)»          |
| **D Backlog**     | Disconnect → 3 шт → Connect | в ленте badge `backlog`                     |
| **E Idempotency** | два create с одним ключом   | тот же id, без второго live-push            |

## Замечания

- Клиент дедуплицирует WS-события по `id` (at-least-once от sweeper/backlog безопасен).
- Socket.IO: CDN `cdn.socket.io`, фолбэк `/demo/vendor/socket.io.esm.min.js`.
- Нужны `AUTH_DEV_TOKENS_ENABLED=true` и `JWT_SECRET` на стенде.
