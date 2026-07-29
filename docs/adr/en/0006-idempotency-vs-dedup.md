# ADR-0006: Idempotency-Key separate from business dedup

**Язык / Language:** [Русский](../0006-idempotency-vs-dedup.md) · English

← [All ADRs](../README.en.md)

## Context

A notification producer (at-least-once queue, HTTP timeout) may retry
`POST /notifications` with the same intent. In parallel, R6 collapses content duplicates
within 5 minutes. These mechanisms must not be mixed.

## Decision

Two independent layers:

| Layer           | Key                               | Window    | Effect                                 |
| --------------- | --------------------------------- | --------- | -------------------------------------- |
| Idempotency-Key | header + sha256(body)             | 24 hours  | same HTTP response, no second create   |
| Dedup (R6)      | `dedup_hash` by user/type/payload | 5 minutes | `occurrences++`, status `deduplicated` |

Table `idempotency_keys` stores the response. A concurrent retry (key claimed, no response yet)
→ `409` + `Retry-After: 1` instead of blocking wait.

## Alternatives

| Option                       | Why rejected                                                                 |
| ---------------------------- | ---------------------------------------------------------------------------- |
| Dedup R6 only                | Different payload/key order on retry creates a second entity; no HTTP replay |
| Blocking `SELECT FOR UPDATE` | Holds a connection during slow create; worse than 409 + short retry          |
| Idempotency = dedup hash     | Mixes transport and product rule; breaks intentional “similar” events        |

## Consequences

- Pros: retries are safe; dedup stays a product rule; the ADR explains the difference to reviewers.
- Cons: after a crash past claim the client may get 409 until TTL/pending cleanup (accepted trade-off).

## Revisit trigger

If creates become long (>1s) with frequent parallel retries — consider a short wait/notify
instead of immediate 409.
