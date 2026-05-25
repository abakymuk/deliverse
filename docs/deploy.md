# Deploy Runbook

> First-time setup of the full Doppler + Vercel + Neon + GitHub Actions stack. Estimated time: 90 minutes if accounts are new, 30 minutes if you have them.

> Day-to-day deploy ops are in `docs/environments.md`.

---

## Prerequisites

- [ ] GitHub account with repo
- [ ] Credit card (free tiers cover everything below for solo dev, but accounts may require card on file)
- [ ] Domain you control (e.g., `deliverse.app`)
- [ ] DNS provider with API access (Cloudflare recommended)

---

## Step 1: Neon (~10 min)

1. Sign up at [neon.tech](https://neon.tech)
2. Create project: `deliverse`
3. Region: choose closest to your customers (e.g., `aws-us-west-2` for OC)
4. Postgres version: latest (16 at time of writing)
5. After creation, the default branch is `main` — rename or ignore.

Create three branches via Neon dashboard → Branches → Create:

| Branch | Parent | Auto-suspend |
|---|---|---|
| `production` | main | Disabled |
| `staging` | production | Disabled |
| `dev` | production | 5 min |

For each branch, click → Connection Details → copy connection string with `Pooled connection`. You'll have three URLs:

```
DATABASE_URL (dev)          → postgres://user:pwd@ep-xxx.../neondb?sslmode=require
DATABASE_URL (staging)      → postgres://user:pwd@ep-yyy.../neondb?sslmode=require
DATABASE_URL (production)   → postgres://user:pwd@ep-zzz.../neondb?sslmode=require
```

Save these — you'll paste into Doppler next.

---

## Step 2: Doppler (~15 min)

1. Sign up at [doppler.com](https://doppler.com)
2. Create project: `deliverse`
3. Doppler creates 3 default environments: `dev`, `stg`, `prd`. Keep these names — our scripts assume them.

For each environment's config, add these secrets:

### `dev` config
```
DATABASE_URL                       = <Neon dev URL>
BETTER_AUTH_SECRET                 = <openssl rand -base64 32>
BETTER_AUTH_URL                    = http://localhost:3000
GOOGLE_CLIENT_ID                   = <from Google Cloud Console>
GOOGLE_CLIENT_SECRET               = <from Google Cloud Console>
RESEND_API_KEY                     = <Resend test key, starts with re_>
RESEND_FROM_EMAIL                  = onboarding@resend.dev
NEXT_PUBLIC_PLATFORM_URL           = http://localhost:3000
NEXT_PUBLIC_STOREFRONT_BASE_DOMAIN = localhost:3001
INNGEST_EVENT_KEY                  = (optional in dev)
INNGEST_SIGNING_KEY                = (optional in dev)
```

### `stg` config
```
DATABASE_URL                       = <Neon staging URL>
BETTER_AUTH_SECRET                 = <fresh openssl rand -base64 32>
BETTER_AUTH_URL                    = https://admin.staging.deliverse.app
GOOGLE_CLIENT_ID                   = <same as dev, but add stg redirect URI in Google Console>
GOOGLE_CLIENT_SECRET               = <same as dev>
RESEND_API_KEY                     = <Resend test key>
RESEND_FROM_EMAIL                  = noreply@staging.deliverse.app
NEXT_PUBLIC_PLATFORM_URL           = https://admin.staging.deliverse.app
NEXT_PUBLIC_STOREFRONT_BASE_DOMAIN = staging.deliverse.app
```

### `prd` config
```
DATABASE_URL                       = <Neon production URL>
BETTER_AUTH_SECRET                 = <fresh openssl rand -base64 32>
BETTER_AUTH_URL                    = https://admin.deliverse.app
GOOGLE_CLIENT_ID                   = <new Google OAuth app for prd; verified domain>
GOOGLE_CLIENT_SECRET               = <new>
RESEND_API_KEY                     = <Resend prod key, requires verified domain>
RESEND_FROM_EMAIL                  = noreply@deliverse.app
NEXT_PUBLIC_PLATFORM_URL           = https://admin.deliverse.app
NEXT_PUBLIC_STOREFRONT_BASE_DOMAIN = deliverse.app
```

**Generate fresh secrets per environment.** Reusing the same `BETTER_AUTH_SECRET` across environments means stg compromise = prd compromise.

---

## Step 3: Install Doppler CLI + local setup (~5 min)

```bash
# macOS
brew install dopplerhq/cli/doppler

# Other platforms
curl -Ls https://cli.doppler.com/install.sh | sh

# Authenticate
doppler login

# Link this repo to Doppler project
cd /path/to/deliverse
doppler setup
# When prompted: select project "deliverse", config "dev"
```

Test:
```bash
doppler run -- env | grep DATABASE_URL
# Should print the dev DB URL
```

---

## Step 4: Apply initial schema to all envs (~5 min)

From local, against each branch:

```bash
# Dev
doppler run -- pnpm db:generate    # Creates migration files
doppler run -- pnpm db:migrate     # Applies to dev DB

# Staging — temporarily switch config
doppler setup --config stg
doppler run -- pnpm db:migrate

# Production — same
doppler setup --config prd
doppler run -- pnpm db:migrate

# Switch back to dev for daily work
doppler setup --config dev
```

After this, all three DBs have schema. Going forward, migrations run via CI.

---

## Step 5: Vercel projects (~15 min)

1. Sign up at [vercel.com](https://vercel.com) (free Pro trial often available)
2. Connect GitHub account
3. Import the `deliverse` repo **twice** — once per app:

### Platform project
- Name: `deliverse-platform`
- Root Directory: `apps/platform`
- Framework Preset: Next.js
- Build Command: leave default
- Output Directory: leave default

### Storefront project
- Name: `deliverse-storefront`
- Root Directory: `apps/storefront`
- Framework Preset: Next.js

For both projects: in Settings → Git → disable "Auto-deploy" on `main` and `staging` branches. We'll deploy via GitHub Actions instead.

Keep "Auto-deploy on PR" enabled for preview deploys (these use dev DB).

---

## Step 6: Connect Doppler ↔ Vercel (~5 min)

In Doppler dashboard:

1. Integrations → Vercel → Authorize
2. For each Doppler config, add a sync:
   - `dev` config → Vercel project `platform` + `storefront`, environment **Preview**
   - `stg` config → Vercel project `platform` + `storefront`, environment **Preview** (specific to `staging` branch — Vercel calls this "Custom Environment")
   - `prd` config → Vercel project `platform` + `storefront`, environment **Production**

Doppler now pushes env vars to Vercel automatically on any change.

Verify: open Vercel project → Settings → Environment Variables. You should see vars pushed from Doppler, marked as "Managed by Doppler".

---

## Step 7: Custom domains (~10 min)

In each Vercel project → Settings → Domains, add:

### Platform project
- `admin.deliverse.app` → Production
- `admin.staging.deliverse.app` → Custom env: staging

### Storefront project
- `*.deliverse.app` → Production (wildcard)
- `*.staging.deliverse.app` → Custom env: staging (wildcard)

Vercel will show DNS records you need to add. In Cloudflare (or your DNS):

```
deliverse.app                     A     76.76.21.21
admin.deliverse.app               CNAME cname.vercel-dns.com
*.deliverse.app                   CNAME cname.vercel-dns.com
staging.deliverse.app             CNAME cname.vercel-dns.com
admin.staging.deliverse.app       CNAME cname.vercel-dns.com
*.staging.deliverse.app           CNAME cname.vercel-dns.com
```

⚠️ In Cloudflare, set these records to "DNS only" (gray cloud), NOT proxied. Vercel needs direct access for SSL provisioning.

Wait 5-15 min for DNS propagation and Let's Encrypt certificate issuance.

---

## Step 8: GitHub Actions secrets (~10 min)

Get the values:

### Doppler service tokens
1. Doppler dashboard → `deliverse` → `stg` config → Access → Service Tokens → Create
2. Name: `github-actions-stg`. Access: Read.
3. Copy the `dp.st.stg.xxxxx` token.
4. Repeat for `prd` config → token `github-actions-prd`.

### Vercel tokens
1. Vercel dashboard → Account Settings → Tokens → Create
2. Name: `github-actions`. Scope: full account.
3. Get IDs: in your repo's root, run `vercel link` for each app, then `cat .vercel/project.json` to get `orgId` and `projectId`.

### Add to GitHub
Repo → Settings → Secrets and variables → Actions → New repository secret:

| Name | Value |
|---|---|
| `DOPPLER_TOKEN_STG` | `dp.st.stg.xxxxx` |
| `DOPPLER_TOKEN_PRD` | `dp.st.prd.xxxxx` |
| `VERCEL_TOKEN` | from Vercel |
| `VERCEL_ORG_ID` | from `.vercel/project.json` |
| `VERCEL_PROJECT_PLATFORM_ID` | platform project ID |
| `VERCEL_PROJECT_STOREFRONT_ID` | storefront project ID |

### GitHub Environments (for approval gate)

1. Repo → Settings → Environments → New environment: `production`
2. Required reviewers: add yourself
3. Save

This makes prd deploys require a button click.

---

## Step 9: Git branches setup (~5 min)

```bash
git checkout main
git pull
git checkout -b staging
git push -u origin staging
```

Set branch protections in GitHub:
- `main`: require PR, require CI to pass, no direct pushes
- `staging`: require CI to pass

---

## Step 10: First deployment (~10 min)

### Staging
```bash
# From a feature branch
git checkout staging
git pull
# Make any trivial change (e.g., add a comment)
git commit -am "test: verify staging deploy"
git push origin staging
```

Watch GitHub Actions tab. The `Deploy Staging` workflow should run:
1. Migrate stg DB
2. Deploy platform to Vercel staging
3. Deploy storefront to Vercel staging

Visit `https://admin.staging.deliverse.app`. Should load login page.

### Production
```bash
# Open PR staging → main on GitHub
# Merge after CI passes
# Workflow Deploy Production starts
# Approve via GitHub Environments
```

Visit `https://admin.deliverse.app`. Should load login page.

---

## Step 11: Smoke tests (~5 min)

For each environment:

- [ ] Platform: load login page
- [ ] Platform: register a test account (or use seeded admin)
- [ ] Platform: log in successfully, see dashboard
- [ ] Storefront: visit `{seed-brand}.<env>.deliverse.app`
- [ ] Storefront: brand name renders correctly
- [ ] Storefront: request OTP → received in email
- [ ] Storefront: log in with OTP → see account page

If any fail: check Vercel function logs and Sentry (when configured).

---

## Troubleshooting

### "Doppler not finding project"
```bash
doppler setup --no-interactive --project deliverse --config dev
```

### "Vercel deploy fails: missing DATABASE_URL"
Check Doppler ↔ Vercel sync is enabled. Doppler dashboard → Integrations → Vercel. Re-run sync.

### "Migration runs but app shows old schema"
Vercel build is cached. Trigger redeploy via Vercel CLI or push empty commit.

### "Wildcard subdomain returns 404"
Vercel needs both:
1. Wildcard CNAME in DNS
2. Wildcard domain added to Vercel project (`*.deliverse.app`)
Both must be present.

### "Storefront returns 500 with 'No brand specified'"
DNS resolves but proxy rejects. Check `NEXT_PUBLIC_STOREFRONT_BASE_DOMAIN` env var matches actual base domain.

---

## What's NOT in this runbook

- Stripe / billing setup → separate runbook when adding billing
- Sentry / PostHog config → optional, add in week 2
- Inngest jobs → only when first async job is added
- Custom email domain verification → after first 50 customers

Keep it minimal until the next thing actually hurts.

<!-- deploy test: 2026-05-24 -->
