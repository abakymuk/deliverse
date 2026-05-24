# 0002 — Better-Auth, not Clerk

**Date:** 2026-05-23
**Status:** Accepted

## Context

B2B2C SaaS with three user populations including tenant-scoped end users in restaurant brands. Need: multi-tenant org support, email OTP, OAuth, password, hybrid flows.

## Decision

Self-host Better-Auth with two instances (one per app).

## Alternatives Considered

- **Clerk** — rejected: $0.02/MAU pricing kills B2B2C unit economics. Tenant-scoped end users mean potentially thousands of MAU per tenant; at scale, auth cost would exceed product revenue
- **Auth.js (NextAuth)** — rejected: too low-level for multi-tenancy; would build half of Better-Auth ourselves
- **Supabase Auth** — rejected: no first-class tenant-scoped identity, RLS doesn't cover (same email, different tenants) cleanly
- **WorkOS** — rejected: enterprise-only pricing, not aligned with consumer B2B2C
- **Lucia** — rejected: in maintenance mode since spring 2025
- **Better-Auth** — selected: native multi-tenancy via organization plugin, Drizzle-first, hybrid auth methods supported, active development, self-host eliminates per-MAU costs

## Consequences

### Positive
- Linear cost (Postgres + Resend), not per-MAU
- Full control over schema and flows
- Two-instance pattern fits two-app architecture naturally
- Modern: passkeys path for v2

### Negative
- More code in our repo than a hosted solution
- We own the security maintenance burden
- Mitigation: pin to LTS-equivalent versions, monitor BA changelog

### Neutral
- BA model name vs table name mapping requires care
- Documented in AGENTS.md and per-app auth.ts files
