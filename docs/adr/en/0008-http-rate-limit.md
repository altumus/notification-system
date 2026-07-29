# ADR-0008: Per-IP transport rate limit on top of the business limit

**Язык / Language:** [Русский](../0008-http-rate-limit.md) · English

← [All ADRs](../README.en.md)

## Context

R5 is covered by the business limit: no more than 10 notifications per minute per
`(user_id, type)` ([ADR-0004](./0004-rate-limit-in-postgres.md)). That limit, however, is counted
**in PostgreSQL**, inside a transaction holding an advisory lock. Every rejected request still
costs JSON parsing, DTO validation, JWT verification, a pooled connection and a database query.
The flooder gets a 429; the server pays for it in resources.

`POST /auth/dev-token` is a separate concern: the route is anonymous (`@Public`) and is the only
endpoint in the API that burns CPU on JWT signing without touching the database at all.

## Decision

A second, transport-level layer: `@nestjs/throttler` via `HttpThrottlerGuard`, registered as an
`APP_GUARD` inside `RateLimitModule`.

- The key is the **client IP** (`req.ips[0]` behind `trust proxy`, otherwise `req.ip`), not
  `userId`: before authentication the `userId` is unknown, and it is exactly the anonymous stream
  that needs protecting.
- `RateLimitModule` is imported into `AppModule` **before** `AuthModule` — Nest invokes
  `APP_GUARD`s in registration order, so the limit cuts off floods before JWT verification.
- The bucket is an `(IP, route)` pair (library default): a heavy `POST` does not share its budget
  with a cheap `GET`.
- Values: `HTTP_RATE_LIMIT=300` per `HTTP_RATE_WINDOW_MS=60000`. For comparison, the demo page in
  its chattiest scenario issues ~20 requests, and an honest client hits the business limit
  (10/min) long before the transport one.
- `POST /auth/dev-token` gets its own `@Throttle` at 20/min. The value is deliberately a
  **constant in code**, not an env var: it is a security floor, not an operational knob.
- `/health/live` and `/health/ready` are marked `@SkipThrottle`: docker HEALTHCHECK and Railway
  probes arrive from a single address, so throttling them would take down a deploy rather than an
  attacker.
- The response is `problem+json` with code `too-many-requests` plus `RateLimit-*` / `Retry-After`
  headers. The distinct `type` matters: a client must tell "too many notifications of this type"
  (`rate-limit-exceeded`, retrying is pointless until the window ends) from "too many requests".

## Alternatives

| Option                                    | Why rejected                                                                                                       |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Rely on the database business limit alone | Every junk request reaches Postgres; anonymous `/auth/dev-token` is not covered at all                             |
| Limit at nginx / edge                     | The stand runs on Railway with no own reverse proxy; the rule would live outside the repo and stay untested        |
| Key by `userId` instead of IP             | Requires verifying the JWT first — paying for exactly the work we are defending against                            |
| One shared per-IP bucket across all paths | A burst of cheap `GET`s would eat the `POST` budget, and a per-route `@Throttle` would clash with a shared counter |
| `ThrottlerStorageRedis` right away        | A second infrastructure service for a limit that is already exact on a single instance (`REDIS_URL` is reserved)   |

## Consequences

- Pros: floods are cut off before the database and before JWT signing; anonymous routes are
  covered; the error contract stays intact — 429 remains `problem+json` with a machine-readable
  code.
- Cons:
  - Counters live in process memory. With N replicas the effective limit is
    N × `HTTP_RATE_LIMIT` (a client lands on different instances). Enough as flood protection,
    not enough as an exact quota.
  - Clients behind a shared NAT share a bucket. At 300/min per endpoint this only shows up for
    clearly automated traffic.
  - k6 load profiles come from a single IP and would hit the limit, so runs require
    `HTTP_RATE_LIMIT_ENABLED=false` on the stand (see [performance.md](../../en/performance.md)).

## Revisit trigger

Moving to multiple API replicas. At that point the counter moves to `ThrottlerStorageRedis` via
`REDIS_URL` — the same move as the Socket.IO adapter, because both problems reduce to the same
thing: shared state across instances.
