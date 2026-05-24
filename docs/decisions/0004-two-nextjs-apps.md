# 0004 — Two Next.js apps (not one)

**Date:** 2026-05-23
**Status:** Accepted

## Context

Platform admin (for staff and tenant operators) and storefront (for guests) have different audiences, branding, auth methods. Should they be one app with routes or two apps?

## Decision

Two separate Next.js apps in monorepo: `apps/platform` and `apps/storefront`.

## Alternatives Considered

- **One app, role-based routes (`/admin/*` vs `/store/*`)** — rejected: security boundary becomes an `if` statement; cookies leak between contexts; first auth bug = catastrophe
- **One app with subdomain-based routing in middleware** — rejected: still single deploy, single cookie domain, mixed concerns
- **Two apps (selected):** network boundary = security boundary

## Consequences

### Positive
- Cookies physically scoped: `admin.*` cookies cannot reach `*.brand.*`
- Independent deploys: platform changes don't risk customer-facing pages
- Different optimization: storefront cached aggressively, platform real-time
- Cleaner mental model

### Negative
- 2x build/deploy pipeline
- Shared code lives in packages (more files)
- More config files

### Neutral
- Two Better-Auth instances follows naturally
- Both apps deploy to Vercel; cost similar to single-app
