# ADR-0003: Fixed dedup window from the first occurrence

**Язык / Language:** [Русский](../0003-dedup-window-semantics.md) · English

← [All ADRs](../README.en.md)

## Context

Requirement R6: duplicates within 5 minutes collapse into one. We must choose window semantics —
fixed from the anchor’s `created_at`, or sliding from the last duplicate.

## Decision

A **fixed window** tied to the existing anchor notification’s `created_at`:
a duplicate within `DEDUP_WINDOW` after the anchor was created increments `occurrences` and
updates `last_seen_at`, but does not create a new row and does not emit a WS push.

## Alternatives

| Option                             | Why rejected                                                                                              |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Sliding window from `last_seen_at` | A stream of duplicates every 4 minutes extends one row forever — the user stops getting new notifications |
| Unique index without a time window | Does not allow “similar events later”; breaks legitimate repeats                                          |

## Consequences

- Pros: predictable for users; anchor lookup is bounded by `created_at` → partition pruning.
- Cons: two identical events 5+ minutes apart become two rows (intentional).

## Revisit trigger

If product needs “keep collapsing while the same orderId keeps updating” with no hard upper
bound — consider a hybrid with a hard TTL on the anchor.
