# 0006 — Neon Postgres (serverless)

**Date:** 2026-05-23
**Status:** Accepted

## Context

We need managed Postgres for 3 environments (dev / stg / prd). Multi-tenant B2B2C SaaS with mostly small, frequent reads (storefront page loads, session lookups, menu queries) and occasional heavier writes (orders, analytics).

Specific requirements:
- Branching for cheap per-environment isolation
- Scale-to-zero economics for dev/stg environments
- Compatible with Vercel serverless functions
- No vendor extensions (must remain portable)
- Pure Postgres knowledge transfers (no proprietary query language)

## Decision

Use **Neon** as managed Postgres provider for all three environments.

## Alternatives Considered

- **Supabase** — rejected: we don't use Auth (chose Better-Auth), Storage (will use S3/R2), or Realtime. Paying bundled price for unused features. RLS-based multi-tenancy doesn't fit our `(tenant_id, email) UNIQUE` model cleanly.
- **AWS RDS** — rejected: no scale-to-zero, no instant branching, expensive for small workloads ($30+/mo baseline per instance × 3 envs).
- **Render Postgres** — rejected: smaller scale, fewer features, no branching.
- **Self-hosted on Fly.io / Hetzner** — rejected: operational burden incompatible with solo dev. Backup, replication, monitoring all on us.
- **PlanetScale (now MySQL-only after Postgres pivot)** — rejected: not relevant after their direction change.
- **Neon (selected)** — branching solves multi-env elegantly; serverless model fits Vercel deployment; pure Postgres preserves portability.

## Consequences

### Positive

- **Branching enables clean 3-env workflow.** Each environment is a branch off main. Copy-on-write means stg branch costs near zero until written to.
- **Scale-to-zero on dev/stg.** No 24/7 compute costs for environments we don't use overnight.
- **Vercel-native.** Connection pooling via Neon's serverless driver handles cold-start scenarios out of the box.
- **Point-in-time recovery** (up to 7 days on Launch plan) — rollback safety net for prod migrations.
- **Drizzle-compatible** with no special setup; uses standard `postgres-js` driver.

### Negative

- **Cold starts on free tier** (~1-2s when waking from sleep). Mitigation: paid Launch plan ($19/mo) for stg/prd disables this.
- **Databricks acquisition (May 2025)** — uncertainty about enterprise pivot in 2-3 year horizon. Mitigation: we use pure Postgres with no Neon-specific features. Migration to RDS or self-hosted is a 1-day task if needed.
- **Pricing scales with storage + compute hours.** Cheaper than RDS at our scale; could exceed RDS at >100GB DB. Revisit at that scale.

### Neutral

- Connection pooling parameters in `packages/db/src/client.ts` are already tuned for serverless (`prepare: false, max: 1`).
- We get a Postgres instance, not a Postgres-shaped abstraction. Use `psql`, `pg_dump`, standard tooling.

## Operational notes

| Branch | Purpose | Compute | Auto-suspend |
|---|---|---|---|
| `production` | Prod data | Always on | No |
| `staging` | Long-lived stg | Always on | No |
| `dev` | Shared dev DB | Scale to zero | 5 min idle |
| `preview/<slug>` | Ephemeral per-PR | Scale to zero | 5 min idle |

## References

- [Neon branching docs](https://neon.tech/docs/introduction/branching)
- [Neon + Vercel integration](https://neon.tech/docs/guides/vercel)
- Databricks acquisition announcement: May 14, 2025
- See `docs/environments.md` for branch usage.
