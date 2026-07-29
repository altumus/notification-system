# ADR-0007: Railway вместо VPS + Caddy для тестового стенда

**Язык / Language:** Русский · [English](./en/0007-railway-instead-of-vps-caddy.md)

← [Все ADR](./README.md)

## Контекст

R11 требует публичный HTTPS/WSS URL. В PLAN.md заложен VPS + docker compose + Caddy.

## Решение

Тестовый стенд деплоится на **Railway**: Dockerfile-сервис API + managed Postgres. TLS и WebSocket-прокси даёт edge Railway.

## Альтернативы

| Вариант        | Почему не выбран сейчас                                                                    |
| -------------- | ------------------------------------------------------------------------------------------ |
| VPS + Caddy    | Больше ops (DNS, firewall, renewals); имеет смысл при жёстких требованиях к инфраструктуре |
| Render/Fly.io  | Аналогично Railway; выбран Railway как уже используемая платформа                          |
| Netlify/Vercel | Нет долгоживущего Node + native WebSocket + Postgres в одной модели                        |

## Последствия

- Плюсы: быстрый HTTPS/WSS, меньше скриптов деплоя, managed Postgres.
- Минусы: vendor lock-in edge/DNS; тонкая настройка Postgres ограничена планом Railway.
- Триггер пересмотра: нужна мульти-регион реплика, свой VPS или on-prem.
