# Demo page `/demo`

**Язык / Language:** [Русский](../demo.md) · English

Public test page: REST + WebSocket, no bundler.

Local URL: `http://localhost:3000/demo/` (after `make up` / `pnpm dev`).  
Stand: https://notification-system-production-0ee5.up.railway.app/demo/

## How to use

1. **Prepare** — issues userId, a dev token, and connects WebSocket.
2. Run scenarios **A → E** in order. Watch the WS feed and HTTP log on the right.
3. The HTTP log shows meaning («Created», «Deduplicated», «Rate limited 429»); click a row to expand JSON.
4. In **Session** — rate-limit timer: after 429 it counts down using `Retry-After`.
5. **Manual send** — type/payload, burst, Idempotency-Key preview.

## Scenarios

| Button            | What it does              | What to expect                             |
| ----------------- | ------------------------- | ------------------------------------------ |
| **A Live**        | 1 × `chat.message` online | HTTP «Created» (201), `live` in the feed   |
| **B Dedup**       | same order ×3             | 201, then two «Deduplicated»; one event ×3 |
| **C Rate limit**  | 15 different messages     | after ~10 — «Rate limited (429)»           |
| **D Backlog**     | Disconnect → 3 → Connect  | `backlog` badge in the feed                |
| **E Idempotency** | two creates with one key  | same id, no second live push               |

## Notes

- The client deduplicates WS events by `id` (at-least-once from sweeper/backlog is safe).
- Socket.IO: CDN `cdn.socket.io`, fallback `/demo/vendor/socket.io.esm.min.js`.
- Requires `AUTH_DEV_TOKENS_ENABLED=true` and `JWT_SECRET` on the stand.
