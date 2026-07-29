# ADR-0001: Kysely + SQL migrations instead of an ORM

**Язык / Language:** [Русский](../0001-kysely-vs-orm.md) · English

← [All ADRs](../README.en.md)

## Context

The `notifications` table is partitioned by `created_at`, uses a composite PK `(id, created_at)`,
partial indexes, `pg_advisory_xact_lock`, and needs tight control over query plans (`EXPLAIN`).
We need typed SQL access without giving up DDL control.

## Decision

Use `pg.Pool` + **Kysely** as a typed query builder and **node-pg-migrate**
with plain `.sql` migrations.

## Alternatives

| Option                    | Why rejected                                                                                      |
| ------------------------- | ------------------------------------------------------------------------------------------------- |
| Prisma                    | Diff/migrations fight declarative partitioning and partial indexes; advisory locks become awkward |
| TypeORM                   | Decorator-driven schema drifts from real partition DDL; complex queries still go raw              |
| Plain `pg` without Kysely | Works, but no compile-time checks for column names / `RETURNING` shapes                           |

## Consequences

- Pros: reviewers see real SQL; types stay honest about nullable/`bytea`/`timestamptz`; partitions and indexes are explicit.
- Cons: more code than a “magic” ORM; schema types must be maintained by hand (or via `kysely-codegen` later).

## Revisit trigger

If a chosen ORM gains first-class RANGE partitions and partial indexes without workarounds —
reconsider. Until then Kysely owns typing and SQL remains the source of truth.
