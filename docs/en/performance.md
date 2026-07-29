# Performance and load testing

**Язык / Language:** [Русский](../performance.md) · English

← [Documentation index](../README.en.md)

Requirement R4 is to sustain 500,000 notifications/day. Below: the capacity math, target
numbers, and the k6 profiles that verify them.

## What 500k/day means

| Metric                     | Value                               |
| -------------------------- | ----------------------------------- |
| Average write throughput   | 500,000 / 86,400 ≈ **5.8 rps**      |
| ×10 peak (uneven day)      | ≈ **60 rps**                        |
| Row + indexes (measured)   | 192 B + 403 B ≈ **595 B**           |
| Data growth                | ≈ **295 MB/day**, ≈ **106 GB/year** |
| Rows per monthly partition | ≈ **15M**                           |

Row size is measured, not estimated: 44,185 rows took 8.3 MB of heap and 17 MB of indexes (see
[results](#measured-results)). Indexes cost more than the data itself — that is the price of the
partial unread index, the dedup index and the rate-limit index.

Average load is modest — the real risk is not RPS but accumulated volume: without
partitioning, indexes over hundreds of millions of rows degrade, and a `DELETE`-based
retention creates VACUUM debt. See
[ADR-0002](./../adr/en/0002-partitioning-and-uuidv7.md) and
[ADR-0005](./../adr/en/0005-retention.md).

## Targets

| Operation                   | p95 target | p99 target | Rationale                                                           |
| --------------------------- | ---------- | ---------- | ------------------------------------------------------------------- |
| `POST /notifications`       | < 200 ms   | < 500 ms   | transaction with an advisory lock and up to 4 queries inside        |
| `GET /notifications/unread` | < 100 ms   | < 250 ms   | keyset scan over a partial index, no transaction                    |
| `GET .../unread/count`      | < 100 ms   | < 250 ms   | counting capped at `cap + 1`                                        |
| WebSocket delivery          | < 200 ms   | —          | push happens after COMMIT; asserted in `test/e2e/realtime-delivery` |

Query plans are additionally pinned via `EXPLAIN` in `test/integration/schema.spec.ts` and
`test/integration/notifications-read.spec.ts` — this guards against silently losing an index
or partition pruning during refactoring.

## k6 profiles

Scenarios live in [`load/`](../../load). You need
[k6](https://k6.io/docs/get-started/installation/) and a running stack (`make up`).

| File                           | What it exercises                                       |
| ------------------------------ | ------------------------------------------------------- |
| `load/create-notifications.js` | writes: many recipients, several types, unique payloads |
| `load/read-unread.js`          | reads: unread list and badge counter                    |
| `load/hot-pair.js`             | worst case: all load on a single `(userId, type)` pair  |

The profile is selected via `LOAD_PROFILE`:

| Profile    | Writes  | Reads    | Purpose                            |
| ---------- | ------- | -------- | ---------------------------------- |
| `baseline` | 6 rps   | 50 rps   | average daily load at 500k/day     |
| `peak`     | 60 rps  | 300 rps  | ×10 peak                           |
| `stress`   | 300 rps | 1000 rps | ×50: find where degradation starts |
| `ci`       | 20 rps  | 50 rps   | short pipeline run                 |

```bash
make up                                    # start the stack
pnpm load                                  # writes, baseline
make load-peak                             # writes, ×10 peak
pnpm load:read                             # reads
pnpm load:hot-pair                         # hot pair
k6 run -e LOAD_PROFILE=stress load/create-notifications.js
```

Against a remote stand:

```bash
k6 run -e BASE_URL=https://your-app.up.railway.app load/create-notifications.js
```

`AUTH_DEV_TOKENS_ENABLED=true` is required — the scenarios obtain a service token themselves
via `POST /auth/dev-token`.

`HTTP_RATE_LIMIT_ENABLED=false` is required on the stand as well. The transport rate limit counts
requests per IP ([ADR-0008](./../adr/en/0008-http-rate-limit.md)), while k6 emulates hundreds of
clients from a single address: with the limit on, the profile measures the guard instead of the
API. The business limit on `(userId, type)` stays enabled — that is the one that should produce
429s in the report. In CI this is handled by the "Start stack" step.

## Measured results

Environment: `docker compose` on a single machine (Ryzen 7 7800X3D, 64 GB RAM, Docker 29.0.1),
PostgreSQL 17.10 in a container with `shared_buffers=256MB`, a **single** API instance, k6 in the
same docker network (`BASE_URL=http://api:3000`), `HTTP_RATE_LIMIT_ENABLED=false`. At the time of
the runs the table held ~44k rows in one monthly partition (25 MB including indexes).

| Profile             | Target rps          | Achieved     | p95         | p99         | Thresholds |
| ------------------- | ------------------- | ------------ | ----------- | ----------- | ---------- |
| `create` / `peak`   | 60 rps writes       | 60.01 rps    | **7.39 ms** | **9.03 ms** | passed     |
| `create` / `stress` | 300 rps writes      | 300.00 rps   | **7.54 ms** | —           | passed     |
| `read` / `peak`     | 300 iterations/s    | 599 HTTP rps | **2.93 ms** | **5.56 ms** | passed     |
| `hot-pair` / `peak` | 100 rps to one pair | 100.01 rps   | **3.62 ms** | **5.57 ms** | passed     |

What follows from this:

- **The p95 targets are not merely met but beaten by an order of magnitude** (7.4 ms against a
  200 ms target on writes, 2.9 ms against 100 ms on reads). Zero 5xx, `http_req_failed` = 0.00%
  across all four runs.
- **No ceiling was found at ×50.** `stress` (300 rps of writes = 25.9M notifications/day) runs at
  the same latency as `peak` at one fifth the intensity: p95 7.54 ms versus 7.39 ms. At 500k/day
  the application is nowhere near saturation, so the bottleneck is not here.
- **`hot-pair` does not degrade the way ADR-0004 predicted.** 6,000 requests into a single
  `(userId, type)` pair under one advisory lock produced a p99 of 5.57 ms. The reason: once the
  window is exhausted, a request answers 429 after a single indexed `count` without reaching the
  insert — the short path serializes, not the whole transaction. The ADR-0004 revisit trigger
  still stands, but the boundary is noticeably further out than the paper analysis suggested.
- **These numbers are a lower bound.** k6 ran inside the same docker network, without real network
  RTT and without TLS. On Railway every request additionally pays the trip to the edge; compare
  runs on identical configurations rather than these values against production.

To reproduce:

```bash
docker compose up -d --build api
k6 run -e LOAD_PROFILE=peak load/create-notifications.js
k6 run -e LOAD_PROFILE=peak load/read-unread.js
k6 run -e LOAD_PROFILE=peak load/hot-pair.js
k6 run -e LOAD_PROFILE=stress load/create-notifications.js
```

## How to read the results

- **429 is not a failure.** The profiles mark `429` as an expected status: a triggered rate
  limit confirms R5. Only genuine failures land in `http_req_failed`. If the 429s carry
  `type: too-many-requests`, the transport limit was left enabled — that is no longer R5.
- **`notifications_created` / `notifications_deduplicated` / `notifications_rate_limited`** are
  custom counters showing what the load actually turned into.
- **`hot-pair` is expected to degrade in latency.** Creation takes
  `pg_advisory_xact_lock` on `(userId, type)`, so requests to one pair serialize. The point of
  the scenario is to find the boundary beyond which the counter should move to Redis
  ([ADR-0004](./../adr/en/0004-rate-limit-in-postgres.md)), not to produce nice numbers.
- **A failed `thresholds` check fails the run** — k6 exits non-zero, so the `ci` profile acts
  as a performance regression test in the pipeline rather than a report.

## Limitations of the current setup

- **Single API instance.** `PresenceRegistry` keeps sockets in process memory, and domain
  events go through an in-process `EventEmitter2`. With several replicas, live push works
  within an instance while cross-instance delivery is picked up by `UndeliveredSweeper`
  (delay: `SWEEPER_MIN_AGE_MS`, 30s by default). One instance is enough for 500k/day; for
  fault tolerance a shared adapter is needed (`REDIS_URL` is reserved for that).
- **The rate limit is computed in Postgres** by an indexed query rather than a dedicated
  store. Trade-off and revisit trigger:
  [ADR-0004](./../adr/en/0004-rate-limit-in-postgres.md).
- **The transport rate limit keeps counters in process memory.** With N replicas the effective
  limit is N × `HTTP_RATE_LIMIT`; a shared budget needs `ThrottlerStorageRedis`
  ([ADR-0008](./../adr/en/0008-http-rate-limit.md)).
- **Numbers depend on the environment.** Local `docker compose` and Railway produce different
  results: compare runs on the same configuration rather than absolute values across
  environments.
