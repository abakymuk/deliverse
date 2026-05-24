# 0005 — Doppler + Vercel for secrets and deployment

**Date:** 2026-05-23
**Status:** Accepted

## Context

We need a deployment platform and secrets management strategy that:
- Supports 3 long-lived environments (dev / stg / prd)
- Provides audit log for secret changes
- Survives team growth (Alexey, future collaborators)
- Doesn't require self-hosting infrastructure
- Plays well with Next.js + Vercel-native features

## Decision

- **Deployment:** Vercel (both apps + preview deploys)
- **Secrets:** Doppler as single source of truth, native Vercel integration
- **CI/CD:** GitHub Actions for migration orchestration

## Alternatives Considered

### Secrets management

- **Vercel native env vars** — rejected: no audit log, no versioning, no rollback. Painful when env has 30+ vars across 3 environments. No local dev sync.
- **1Password Secrets Automation** — rejected: $19/user/month, designed for larger teams, overkill for solo + 1 collaborator.
- **AWS Secrets Manager** — rejected: heavyweight, requires AWS account, manual sync to Vercel.
- **Infisical (open source alternative to Doppler)** — considered: cheaper and self-hostable, but Doppler's Vercel integration is more polished. Revisit if Doppler pricing becomes an issue.
- **Doppler (selected)** — single source for local + Vercel + CI, native integrations, audit log, free tier covers small teams, version history with rollback.

### Deployment

- **Vercel (selected)** — Next.js-native, edge caching, zero-config preview deploys, wildcard domain support for multi-tenant subdomains.
- **Cloudflare Pages** — rejected: less mature Next.js 15 support, no native multi-environment workflow.
- **AWS Amplify** — rejected: rough DX, slow deploys, frequent regressions.
- **Self-host on Hetzner/Fly.io** — rejected: ops cost > $20-50/month Vercel saves.

## Consequences

### Positive

- One source of truth for env vars across local, CI, and all deployed environments.
- Adding a new secret = one place to add it; auto-syncs everywhere.
- Audit trail (who changed what, when) — useful for security review.
- Local dev uses `doppler run -- pnpm dev`, no `.env.local` to forget to update.
- Vercel handles wildcard subdomains (`*.yourapp.com`, `*.staging.yourapp.com`) natively for the storefront multi-tenant pattern.
- Preview deploys come for free with Vercel.

### Negative

- Vendor lock-in to Doppler and Vercel. Mitigation: env vars are portable; switching providers takes a day, not weeks.
- $20/mo Vercel Pro + Doppler free → ~$20/mo baseline. Acceptable.
- Service token management adds one more thing to rotate periodically.

### Neutral

- Vercel auto-deploys on git push are disabled in production; deploys go through GitHub Actions to gate on migration success.
- Build-time env vars must be available in Doppler before Vercel can build.

## References

- [Doppler ↔ Vercel integration docs](https://docs.doppler.com/docs/vercel)
- [Vercel wildcard domains](https://vercel.com/docs/projects/domains/working-with-domains#wildcard-domains)
- See `docs/environments.md` for full workflow.
- See `docs/deploy.md` for first-time setup runbook.
