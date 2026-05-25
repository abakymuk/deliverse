# Restaurant Platform

B2B2C white-label SaaS for restaurant brands. Multi-tenant architecture with platform admins, tenant operators, and end-user guests.

> **First-time visitor?** Read `AGENTS.md` next. It's the constitution.

---

## Quick Start

### Prerequisites

- Node.js 22 LTS (see `.nvmrc`)
- pnpm 9+ (`npm install -g pnpm`)
- Doppler CLI (`brew install dopplerhq/cli/doppler`)
- Accounts: Neon, Doppler, Vercel (see `docs/deploy.md` for first-time setup)

### Setup (once accounts are provisioned)

```bash
# 1. Install dependencies
pnpm install

# 2. Link to Doppler
doppler login
doppler setup       # interactive: select project + dev config

# 3. Verify env is reachable
doppler run -- env | grep DATABASE_URL

# 4. Apply schema to your dev DB
doppler run -- pnpm db:generate
doppler run -- pnpm db:migrate
doppler run -- pnpm db:seed     # optional test data

# 5. Start dev servers
doppler run -- pnpm dev

# Platform:    http://localhost:3000
# Storefront:  http://pizza-express.localhost:3001
```

> **First time on this project?** Read `docs/deploy.md` for the full Doppler + Vercel + Neon setup (~90 minutes).

> **No .env.local file is needed.** Doppler injects environment variables at runtime. `.env.example` is documentation only.

### Local subdomain setup

For storefront subdomains in dev, add to `/etc/hosts`:

```
127.0.0.1 pizza-express.localhost
127.0.0.1 burger-heaven.localhost
```

Or use Chrome / Firefox, which auto-resolve `*.localhost`.

### Seeded data

`doppler run -- pnpm db:seed` (step 4 in the Quick Start) populates a deterministic bootstrap dataset every Phase 0 / Phase 1 workstream depends on:

- **Admin:** `admin@test.local` / `Admin-Dev-Pass-1` (override via `SEED_ADMIN_PASSWORD`)
- **Tenant:** `hospitality-group` — admin is `owner`
- **Brands:** `pizza-express`, `burger-heaven`
- **Locations:** Downtown Kitchen, Eastside Kitchen
- **Dark-kitchen link:** Downtown serves both brands via `location_brands`

The script is idempotent (safe to re-run). See [`docs/specs/seed-data.md`](docs/specs/seed-data.md) for the full dataset spec.

---

## Structure

```
deliverse/
├── apps/
│   ├── platform/   → admin.deliverse.app (platform staff + tenant operators)
│   └── storefront/ → {brand}.deliverse.app (end users)
├── packages/
│   ├── db/             → Drizzle schema + client
│   ├── ui/             → shadcn components (shared)
│   ├── auth-core/      → Better-Auth configs (per app)
│   └── typescript-config/ → Shared tsconfig
└── docs/
    ├── architecture.md
    ├── auth-spec.md
    ├── development-workflow.md
    ├── decisions/      → ADRs
    ├── specs/          → Per-feature specs
    └── skills/         → Claude Code reusable skills
```

---

## Common commands

> All app commands run through `doppler run --` to inject env vars.

```bash
# Development
doppler run -- pnpm dev              # All apps
doppler run -- pnpm dev --filter @rp/platform
doppler run -- pnpm dev --filter @rp/storefront

# Database
doppler run -- pnpm db:generate      # Generate migration from schema changes
doppler run -- pnpm db:migrate       # Apply migrations
doppler run -- pnpm db:push          # Sync schema directly (dev only!)
doppler run -- pnpm db:studio        # Open Drizzle Studio
doppler run -- pnpm db:seed          # Re-seed test data

# Quality (no Doppler needed — no env vars)
pnpm typecheck
pnpm lint
pnpm check
pnpm test

# E2E (needs Doppler)
doppler run -- pnpm test:e2e

# Switch environments
doppler setup --config stg           # Point to staging config
doppler setup --config prd           # Point to production config
doppler setup --config dev           # Back to dev
```

> **Tip:** add a shell alias for daily comfort: `alias drp='doppler run --'` → `drp pnpm dev`.

---

## Working with Claude Code (Solo development)

This project is built for solo development with AI assistance. Key documents:

1. **`AGENTS.md`** — Master constitution. Read every session.
2. **`docs/environments.md`** — 3-env workflow (dev/stg/prd), Doppler, Neon branches.
3. **`docs/deploy.md`** — First-time setup runbook (90 min walkthrough).
4. **`docs/development-workflow.md`** — Plan → Build → Sync loop.
5. **`docs/specs/_template.md`** — Use this template for every new feature.
6. **`docs/skills/`** — Reusable patterns (premortem, code review checklist, etc.)

### Session startup ritual

```
1. Read /AGENTS.md
2. Read /docs/specs/<current-feature>.md (if mid-feature)
3. Read /apps/<relevant-app>/AGENTS.md
4. Reference 2-3 existing files matching the area
5. Propose a plan. Wait for approval. Don't code yet.
```

---

## Tech Stack

| Layer | Choice |
|---|---|
| Language | TypeScript 5.x |
| Runtime | Node 22 LTS |
| Framework | Next.js 15 (App Router, RSC, server actions) |
| UI | shadcn/ui + Tailwind v4 |
| Database | Postgres (Neon) |
| ORM | Drizzle |
| Auth | Better-Auth |
| Jobs | Inngest |
| Email | Resend |
| Observability | PostHog + Sentry |
| Tests | Vitest + Playwright |
| Linter | Biome |
| Monorepo | Turborepo + pnpm workspaces |
| Deploy | Vercel (apps) + Neon (DB) |

See `docs/decisions/` for reasoning on each.

---

## Status

See `AGENTS.md → Current Focus` for what's being actively built.

---

## License

Private. Not open source.
