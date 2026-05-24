# Environments

> Three long-lived environments: **dev**, **stg**, **prd**. This document is the source of truth for how they relate, what runs where, and how changes flow between them.

---

## Topology

```
┌─────────────────────────────────────────────────────────────────┐
│  DEV — local development                                         │
│                                                                  │
│  Domain:    localhost:3000 (platform)                           │
│             {brand}.localhost:3001 (storefront)                 │
│  DB:        Neon `dev` branch (shared dev DB, scale-to-zero)    │
│  Secrets:   Doppler config `dev`                                │
│  Git:       feature branches (you work here)                    │
│  Deploys:   local only via `doppler run -- pnpm dev`            │
│  Purpose:   actively building features                          │
└─────────────────────────────────────────────────────────────────┘
                            │
                            │ feature/* → staging (PR)
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│  STG — pre-production                                            │
│                                                                  │
│  Domain:    admin.staging.yourapp.com                           │
│             {brand}.staging.yourapp.com                         │
│  DB:        Neon `staging` branch (long-lived, always on)       │
│  Secrets:   Doppler config `stg`                                │
│  Git:       `staging` branch                                    │
│  Deploys:   GitHub Actions → migrate → Vercel deploy            │
│  Purpose:   integration testing, demo to stakeholders           │
└─────────────────────────────────────────────────────────────────┘
                            │
                            │ staging → main (PR after QA)
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│  PRD — production                                                │
│                                                                  │
│  Domain:    admin.yourapp.com                                   │
│             {brand}.yourapp.com                                 │
│  DB:        Neon `production` branch                            │
│  Secrets:   Doppler config `prd`                                │
│  Git:       `main` branch                                       │
│  Deploys:   GitHub Actions → migrate (with approval) → Vercel   │
│  Purpose:   serves real customers                               │
└─────────────────────────────────────────────────────────────────┘
```

---

## Rules

1. **No code reaches prd without passing through stg.** No exceptions, including "tiny hotfixes."
2. **No migration runs in prd that hasn't run in stg first.** Migration files are committed in PR; applied in order.
3. **No env var added to prd without being added to dev and stg first.** Doppler config sync is a Doppler operation, not a deploy operation.
4. **Stg data is realistic but not real customer data.** Seed with synthetic tenants and end-users for QA.
5. **Stg never reads or writes to prd DB.** Branches are physically separate.
6. **Doppler is the source of truth for secrets.** Never edit env vars in Vercel directly. Never commit `.env` files.

---

## Git workflow

```
main          ← prd, protected branch, only PRs from `staging`
  ↑
staging       ← stg, long-lived, integration testing
  ↑
feature/*     ← dev work, branched off `staging`
```

### Typical change lifecycle

```
1. git checkout staging && git pull
2. git checkout -b feature/tenant-invitations
3. Build feature locally (doppler run -- pnpm dev)
4. Write/update spec in docs/specs/
5. Commit, push, open PR → staging
6. CI runs lint+typecheck+tests on PR
7. Merge PR → staging branch
8. GitHub Actions: migrate stg DB, deploy stg
9. Test on https://admin.staging.yourapp.com
10. When ready: open PR staging → main
11. Code review (self-review for solo, or Alexey when applicable)
12. Merge → main triggers prd deployment workflow
13. Approval gate (GitHub environment "production" requires manual approve)
14. GitHub Actions: migrate prd DB, deploy prd
15. Smoke test https://admin.yourapp.com
```

---

## Secrets (Doppler)

### Project structure

```
Doppler Project: restaurant-platform
├── Environment: dev
│   └── Config: dev (used by local + preview deploys)
├── Environment: stg
│   └── Config: stg
└── Environment: prd
    └── Config: prd
```

### Required variables per environment

```
DATABASE_URL              ← Different Neon connection per env
BETTER_AUTH_SECRET        ← Different per env (generate fresh)
BETTER_AUTH_URL           ← admin.<env>.yourapp.com
GOOGLE_CLIENT_ID          ← Same OAuth app, different redirect URIs registered
GOOGLE_CLIENT_SECRET      ← Same
RESEND_API_KEY            ← Resend supports test keys for dev/stg
RESEND_FROM_EMAIL         ← noreply@<env>.yourapp.com
NEXT_PUBLIC_PLATFORM_URL  ← admin.<env>.yourapp.com
NEXT_PUBLIC_STOREFRONT_BASE_DOMAIN  ← <env>.yourapp.com
INNGEST_EVENT_KEY         ← Per env
INNGEST_SIGNING_KEY       ← Per env
SENTRY_DSN                ← Optional in dev
NEXT_PUBLIC_POSTHOG_KEY   ← Optional in dev
NEXT_PUBLIC_POSTHOG_HOST  ← Same across envs
```

### Adding a new env var

```
1. Add to Doppler `dev` config first (test locally)
2. Add to `stg` config (use stg-specific values)
3. Add to `prd` config (use prd-specific values)
4. Doppler ↔ Vercel sync pushes automatically; no Vercel UI action needed
5. Re-deploy stg and prd to pick up new vars (or wait for next push)
6. Document in .env.example
```

### Local development setup

One-time:
```bash
brew install dopplerhq/cli/doppler
doppler login
cd /path/to/restaurant-platform
doppler setup       # interactive: pick project + dev config
```

Daily:
```bash
doppler run -- pnpm dev
# Doppler injects env vars into the process, no .env.local needed
```

### CI access

GitHub Actions accesses Doppler via **service tokens** (scoped to one config, read-only):

```
GitHub Secrets:
  DOPPLER_TOKEN_STG    ← Service token scoped to stg config
  DOPPLER_TOKEN_PRD    ← Service token scoped to prd config
  VERCEL_TOKEN         ← Vercel deploy hook
  VERCEL_ORG_ID
  VERCEL_PROJECT_PLATFORM_ID
  VERCEL_PROJECT_STOREFRONT_ID
```

Rotate service tokens every 90 days. Doppler dashboard shows token age.

---

## Database (Neon)

### Branch strategy

```
main (orphan, unused)
├── production    ← prd reads/writes
├── staging       ← stg reads/writes
└── dev           ← local dev shared
    └── preview/<slug>  ← ephemeral, per-feature (optional)
```

`production` is the parent for stg and dev when starting fresh. After that they diverge.

### Migrations

| Env | Command | When |
|---|---|---|
| Local iteration | `pnpm db:push` | Fast schema changes, no migration files committed |
| Pre-commit | `pnpm db:generate` | Generate migration file from current schema |
| Staging | `pnpm db:migrate` in CI | Auto on push to `staging` |
| Production | `pnpm db:migrate` in CI | On push to `main`, manual approval required |

**Migration golden rules:**

1. **Always backward compatible.** New columns nullable. Drop columns in a separate migration AFTER code stops referencing them.
2. **Never edit a committed migration file.** Add a new one.
3. **Test on stg before prd.** No exceptions.
4. **Migrations under 30 seconds.** Long migrations (data backfill, large indexes) → use Inngest job, not migration.

### Rollback procedures

#### Migration broke production

Order of escalation:

```
1. App still works?
   YES → fix code, deploy patch (revert PR + redeploy)
   NO  → continue ↓

2. Migration safely reversible?
   YES → write reverse migration, apply via CI
   NO  → continue ↓

3. Restore Neon point-in-time backup (Launch plan: 7 days)
   - Create new branch from timestamp before migration
   - Promote to new production (DNS swap)
   - Investigate offline
```

#### Code broke production

```
Vercel dashboard → Deployments → previous good deploy → "Promote to Production"
This is a 2-click 30-second rollback. Use it.
```

#### Both broke

Pray you have stg parity. Restore Neon point-in-time, deploy last-known-good Vercel deploy. Conduct postmortem in `docs/postmortems/YYYY-MM-DD-<title>.md`.

---

## Deployment flow

### Staging deploy (push to `staging`)

```
1. Git push origin staging
2. GitHub Actions starts:
   a. Checkout code
   b. Install deps (cached)
   c. Fetch stg secrets via Doppler service token
   d. Run `pnpm db:migrate` against stg DB
   e. If migrate succeeds → continue
   f. Deploy platform: `vercel deploy --prebuilt --token=$VERCEL_TOKEN`
   g. Deploy storefront: same
3. Smoke test (optional): hit /health endpoint
```

Total time: ~3-5 min.

### Production deploy (push to `main`)

```
1. Git push origin main (or PR merge from staging)
2. GitHub Actions starts:
   a. Approval gate: GitHub "production" environment requires manual approve
   b. Checkout code
   c. Fetch prd secrets via Doppler service token
   d. Run `pnpm db:migrate` against prd DB
   e. Deploy platform via Vercel CLI
   f. Deploy storefront via Vercel CLI
3. Post-deploy: smoke test, Sentry release marker
```

Total time: ~5-8 min including approval.

### Preview deploys (PR opened)

Vercel auto-builds previews on every PR. These connect to `dev` DB by default (configured in Vercel project settings). No CI orchestration needed.

For features that need schema changes:
- Create Neon preview branch manually
- Override `DATABASE_URL` in Vercel preview environment for that branch
- Clean up branch when PR closes

---

## DNS

Production:
```
yourapp.com                A     76.76.21.21         (Vercel anycast)
*.yourapp.com              CNAME cname.vercel-dns.com
admin.yourapp.com          CNAME cname.vercel-dns.com
```

Staging (subdomain of prod):
```
staging.yourapp.com        CNAME cname.vercel-dns.com
*.staging.yourapp.com      CNAME cname.vercel-dns.com
admin.staging.yourapp.com  CNAME cname.vercel-dns.com
```

Configure these in your DNS provider (Cloudflare recommended). Vercel auto-validates ownership.

**Wildcard certificates** auto-managed by Vercel via Let's Encrypt.

---

## Local dev setup for subdomains

`/etc/hosts` approach:
```
127.0.0.1 pizza-express.localhost
127.0.0.1 burger-heaven.localhost
127.0.0.1 admin.localhost
```

Then visit `http://pizza-express.localhost:3001`. Chrome/Firefox auto-resolve `*.localhost` to `127.0.0.1` without `/etc/hosts` in recent versions.

---

## Costs (May 2026 baseline)

| Service | Plan | Cost |
|---|---|---|
| Vercel | Pro | $20/mo |
| Neon | Launch | $19/mo (includes 3 branches) |
| Doppler | Developer (free) | $0 |
| Resend | Free (3k/mo) | $0 |
| Sentry | Developer (free) | $0 |
| PostHog | Free (1M events/mo) | $0 |
| Cloudflare DNS | Free | $0 |
| **Total baseline** | | **$39/mo** |

Add Inngest Pro at ~$20/mo when you cross free tier (50k function runs).

---

## When to add a 4th environment

Don't, until: paying customers > $5k MRR + an actual incident where stg parity failed you.

Common but premature reasons:
- ❌ "I want a sandbox for trying breaking changes" → use Neon preview branch
- ❌ "I want to demo without affecting customers" → use staging
- ❌ "Customer wants their own env" → that's a contractual question, not infra

Valid reasons:
- ✅ Compliance requires data residency separation (EU prd vs US prd)
- ✅ Multi-region deployment with separate prod DBs
- ✅ Customer with SLA requires isolated infra (enterprise tier)
