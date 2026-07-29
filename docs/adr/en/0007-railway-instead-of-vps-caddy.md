# ADR-0007: Railway instead of VPS + Caddy for the test stand

**Язык / Language:** [Русский](../0007-railway-instead-of-vps-caddy.md) · English

← [All ADRs](../README.en.md)

## Context

R11 requires a public HTTPS/WSS URL. PLAN.md originally assumed VPS + docker compose + Caddy.

## Decision

The test stand deploys on **Railway**: Dockerfile API service + managed Postgres. TLS and
WebSocket proxying are provided by the Railway edge.

## Alternatives

| Option         | Why not chosen now                                                                  |
| -------------- | ----------------------------------------------------------------------------------- |
| VPS + Caddy    | More ops (DNS, firewall, renewals); better when infrastructure control is mandatory |
| Render/Fly.io  | Similar to Railway; Railway was already the preferred platform                      |
| Netlify/Vercel | No long-lived Node + native WebSocket + Postgres in one model                       |

## Consequences

- Pros: fast HTTPS/WSS, fewer deploy scripts, managed Postgres.
- Cons: edge/DNS vendor lock-in; Postgres tuning limited by the Railway plan.
- Revisit trigger: need multi-region replicas, own VPS, or on-prem.
