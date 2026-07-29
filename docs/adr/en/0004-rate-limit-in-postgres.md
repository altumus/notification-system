# ADR-0004: Rate limit in PostgreSQL in the same transaction

**Язык / Language:** [Русский](../0004-rate-limit-in-postgres.md) · English

← [All ADRs](../README.en.md)

## Context

R5: no more than 10 notifications per minute per `(user_id, type)`. The limit must survive
process restarts and stay consistent across multiple instances.

## Decision

Counter = `count(*)` on `notifications_ratelimit_idx` inside a transaction with
`pg_advisory_xact_lock(user, type)`. Only **accepted** rows (newly created) consume the
window; collapsed duplicates and rejected attempts do not.

## Alternatives

| Option                    | Why rejected (initially)                                       |
| ------------------------- | -------------------------------------------------------------- |
| In-process memory counter | Resets on restart; diverges across instances                   |
| Redis ZSET immediately    | Second source of truth for core durability; harder local setup |

## Consequences

- Pros: one source of truth (Postgres); races closed by the advisory lock.
- Cons: at thousands of RPS on a hot `(user, type)` pair, `count` becomes a bottleneck.

## Revisit trigger

At thousands of RPS on one pair — move the hot counter to Redis (Lua / ZSET), keeping Postgres
as the source of truth for accepted rows. A `RateLimiter` interface allows swapping the
implementation without changing the service contract.
