# AGENTS.md

> **Read this first.** Every Claude Code / Cursor session should start by reading this file end-to-end. It is the constitution of this project.

---

## Project Overview

**Restaurant Platform** is a B2B2C white-label SaaS for restaurant brands. Multi-tenant architecture with three user populations: platform staff, tenant staff (restaurant operators), and end users (restaurant guests).

**Status:** Greenfield, solo development with Claude Code.

**Core differentiator:** Agent-first restaurant operations. Auth, infrastructure, and standard SaaS plumbing are **boring tech** — they should be invisible. The product moat lives in restaurant operations workflows we build on top.

---

## Stack (boring tech everywhere except differentiator)

| Layer | Choice | Why |
|---|---|---|
| Language | TypeScript 5.x | AI tooling support, type safety |
| Runtime | Node.js 22 LTS | LTS until 2027 |
| Package manager | pnpm | Workspace support, fast |
| Monorepo | Turborepo | Battle-tested for Next.js |
| Framework | Next.js 15 (App Router) | RSC, server actions, mature |
| UI | shadcn/ui + Tailwind v4 | Copy-paste components, full control |
| Database | Postgres (Neon) | Serverless, branches for previews |
| ORM | Drizzle | TypeScript-native, edge-compatible |
| Auth | Better-Auth | Multi-tenant, self-host, modern |
| Async/Jobs | Inngest | Event-driven, agent-friendly |
| Email | Resend | Simple, deliverability, React templates |
| Analytics | PostHog | Product + flags + session replay |
| Errors | Sentry | Standard, debuggable |
| E2E tests | Playwright | Cross-browser, reliable |
| Unit tests | Vitest | Fast, Vite-native |
| Linter | Biome | One tool, fast |
| Deploy | Vercel (apps), Neon (DB) | Boring, fast |

**Never add a new tool without an entry in `docs/decisions/`.**

---

## Architecture (read carefully)

### Two-app monorepo

```
deliverse/
├── apps/
│   ├── platform/    → admin.deliverse.app
│   │                  Audience: platform staff + tenant operators
│   │                  Auth: Better-Auth instance #1 (password + Google OAuth)
│   │
│   └── storefront/  → {brand-slug}.deliverse.app
│                      Audience: restaurant guests
│                      Auth: Better-Auth instance #2 (OTP + password + Google)
│                      Tenant resolution: subdomain → brand → tenant
│
├── packages/
│   ├── db/          → Drizzle schema + client (shared)
│   ├── ui/          → shadcn components (shared)
│   ├── auth-core/   → Better-Auth helpers (shared)
│   └── typescript-config/
│
└── docs/
    ├── architecture.md
    ├── auth-spec.md
    ├── development-workflow.md
    ├── decisions/     → ADRs (architecture decision records)
    ├── specs/         → Per-feature specs
    └── skills/        → Reusable Claude Code skills
```

**Why two apps, not one:** security boundary = network boundary. Platform cookies cannot leak to storefronts by design. Cannot be undone by a bug in an `if` statement.

### Three user populations

| Population | Identity space | Where they live | App |
|---|---|---|---|
| Platform staff | Global | `platform_users` | platform |
| Tenant staff | Global (same table) | `platform_users` + `tenant_memberships` | platform |
| End users | **Tenant-scoped** | `tenant_end_users` (UNIQUE per tenant) | storefront |

**Critical invariant:** end users are scoped to *tenant*, not brand. One person at Tenant A and Tenant B = two accounts. Same person across all brands of Tenant A = ONE account.

### Tenant domain

```
Tenant (business entity)
  ├── Locations  (physical kitchens)
  ├── Brands     (customer-facing identities, subdomains)
  └── location_brands (M:N — dark kitchen support)
```

End user identity scoped to tenant. Brand provides UX context only (theme, subdomain, email branding).

---

## Conventions

### Files

- TypeScript everywhere. No `.js` files except config (e.g., `next.config.js`).
- Filename casing: `kebab-case.tsx` for components, `kebab-case.ts` for utilities.
- One default export per file, named with PascalCase matching filename.
- Co-locate related files: `feature/components/X.tsx`, `feature/actions.ts`, `feature/types.ts`.

### Code

- Server components by default. Client components (`'use client'`) only when needed (state, effects, browser APIs).
- Server actions for mutations. No `/api/` routes except for auth handler and webhooks.
- Drizzle queries always via `packages/db`. Never instantiate clients in apps.
- All side effects (email, push, analytics) go through Inngest events. No fire-and-forget in request handlers.
- Strict TypeScript. No `any`. Use `unknown` + type guards.
- Zod for runtime validation at boundaries (form input, API payloads, env vars).

### Database

- Soft deletes via `deleted_at` timestamp (not `is_deleted` boolean).
- Partial UNIQUE indexes with `WHERE deleted_at IS NULL` for uniqueness on active rows.
- All timestamps `TIMESTAMPTZ` (with timezone). Never naive timestamps.
- UUIDs for all primary keys (no serial).
- Cascade deletes from parent (tenant → locations → ...).

### Naming

- Database: `snake_case` (table names, column names).
- TypeScript: `camelCase` (variables, functions), `PascalCase` (types, components).
- Drizzle schema: TypeScript fields are `camelCase`, columns are `snake_case` (Drizzle maps).
- Constants: `UPPER_SNAKE_CASE`.

---

## Current Focus

> **Linear is the source of truth for what we're working on.** This section mirrors the active project + milestone in Linear at a glance; the canonical state is in Linear. See `docs/linear-workflow.md` for the rules.

Active project: **Phase 0 — Foundation** (Linear, Urgent, target 2026-06-08).
Active milestone: **M0 — Local-dev unblock**.
Current `Todo`: **DEL-10** — Drizzle schema v1: Better Auth-compatible identity schema.

Phase 0 (M0) backlog after DEL-10:
- DEL-11 — Better Auth config v1: field mappings, plugins, OTP storage (Urgent, blocked by DEL-10)
- DEL-1 — Seed script (Urgent, blocked by DEL-11)
- DEL-2 — Install shadcn primitives + rewrite login forms (High, relatedTo DEL-1)

Phase 1 — Auth Vertical (M1 — Auth end-to-end):
- DEL-3 — Storefront `tenant_id` injection (Urgent)
- DEL-4 — Email delivery architecture (Urgent)
- DEL-5 / DEL-6 — OTP + transactional emails via Inngest → Resend
- DEL-7 — Signup pages + cross-brand disclosure
- DEL-8 — Re-enable E2E in CI
- DEL-9 — OTP rate limiting

**Definition of Done (per feature):**
1. Spec in `docs/specs/<feature>.md` (one page max)
2. Schema migration if needed
3. Server actions + Drizzle queries
4. UI built on shadcn primitives
5. Integration tests for critical paths
6. AGENTS.md updated if conventions changed

---

## Gotchas (real ones, learned the hard way)

> **Add to this list whenever something burns you.**

- **Cookie domain on subdomains:** use `Domain=admin.deliverse.app` (NOT `.deliverse.app`). Wildcard domain leaks cookies between platform and storefronts.
- **Drizzle migration sync:** running `drizzle-kit generate` does NOT push. Use `migrate` explicitly. `push` only for local dev.
- **Better-Auth schema generation:** `npx @better-auth/cli generate` regenerates. Custom additions go in app-level schema, not BA-generated files.
- **Server actions in production:** they require `'use server'` at top of file or directly above function. Missing this fails silently in dev, breaks in prod.
- **Next.js 15 cookies API:** `cookies()` is now async. Must await.
- **Inngest local dev:** runs on separate port (8288). `inngest-cli dev` must be running.
- **shadcn install:** `pnpm dlx shadcn@latest add` — uses `@latest`, not `add` legacy. Old commands fail.

---

## Never Do

- ❌ Add a dependency without justification in `docs/decisions/`.
- ❌ Write your own auth flow. Use Better-Auth.
- ❌ Use `localStorage` for sensitive data. Use httpOnly cookies via Better-Auth.
- ❌ Query end user data without tenant scoping. Always filter by `tenant_id`.
- ❌ Trust `email_verified` from OAuth without re-verification on first link.
- ❌ Store passwords or OTP tokens in plaintext. Always hashed.
- ❌ Use `any` in TypeScript. Use `unknown` + narrowing.
- ❌ Make API routes for things server actions can do.
- ❌ Skip the spec. Features > 2 hours of work need a spec.
- ❌ Use `console.log` in committed code. Use proper logger.
- ❌ Hardcode tenant IDs, brand slugs, env values. Use config.
- ❌ Mix concerns: one feature folder owns its components, actions, types.

---

## Workflow (Plan → Build → Sync)

> See `docs/development-workflow.md` for the full cycle and `docs/linear-workflow.md` for how it maps onto Linear states.

### Phase 1: Plan
Before any code, the session produces:
1. Spec in `docs/specs/<feature>.md` (one page) — this is AC#1 of the Linear issue
2. Acceptance criteria (3-7 testable)
3. Non-goals (what we're NOT doing)
4. Files that will change

User reviews. Iterates. Approves. Linear issue moves `Todo → In Progress` only after approval.

### Phase 2: Build
Vertical slice — end-to-end thinnest possible path through:
- Schema (if needed)
- Server action / API
- UI
- Test

One feature folder per slice. Co-located. Mergeable.

### Phase 3: Sync
- Tests run, pass
- AGENTS.md updated if conventions changed
- Decision recorded in `docs/decisions/` if architecturally significant
- Stale comments removed
- Manual smoke test on dev URL

---

## Session Startup Ritual (for every Claude Code session)

```
1. Read /AGENTS.md (this file)
2. Read /docs/linear-workflow.md (if touching Linear)
3. Read the current Linear `Todo` issue + its linked spec
4. Read /docs/specs/<feature>.md (if working on a feature)
5. Read /apps/<app>/AGENTS.md (if working in a specific app)
6. Read 2-3 reference files matching the area being changed
7. Propose a plan. WAIT for user to approve. Do not start coding.
```

The 30 seconds spent on this ritual saves hours of hallucinated APIs and wrong paths.

---

## Decision Log

See `docs/decisions/` for full ADRs. Highlights:

- **0001:** Monorepo with Turborepo (not Nx, not separate repos)
- **0002:** Better-Auth (not Clerk, not Auth.js, not Supabase Auth)
- **0003:** Tenant-scoped end users (not brand-scoped, not global)
- **0004:** Two Next.js apps (not one app with routes)
- **0005:** Doppler + Vercel (not Vercel env vars alone)
- **0006:** Neon Postgres (not Supabase, not RDS)

---

## Environments

Three long-lived environments, strict promotion order: **dev → stg → prd**. Full workflow in `docs/environments.md`. Setup runbook in `docs/deploy.md`.

| Env | Domain | DB branch | Doppler config | Deploy trigger |
|---|---|---|---|---|
| dev | localhost | Neon `dev` | `dev` | local only |
| stg | `*.staging.deliverse.app` | Neon `staging` | `stg` | push to `staging` |
| prd | `*.deliverse.app` | Neon `production` | `prd` | push to `main` + manual approval |

**Hard rules:**

1. Nothing reaches prd without passing through stg.
2. No migration in prd that hasn't run in stg.
3. No env var added to prd without dev and stg first.
4. Secrets live in Doppler. Never in `.env` files, never directly in Vercel UI.
5. Production deploys require manual approval in GitHub Environments.

**Daily flow:**

```bash
# Local dev (uses Doppler `dev` config)
doppler run -- pnpm dev

# Make changes, commit on feature branch, PR to `staging`
# Auto-deploy to stg on merge

# After stg validation, PR `staging` → `main`
# Auto-deploy to prd on merge (with approval gate)
```

---

## How to ask me (Claude) for help

**Good prompt:**
> "Read AGENTS.md and docs/specs/tenant-invitations.md. We need to add the accept-invitation endpoint. Look at apps/platform/src/app/(auth)/signup/page.tsx for the existing signup pattern. Propose a plan covering: server action signature, DB queries, UI changes, edge cases. Don't write code yet."

**Bad prompt:**
> "Add tenant invitations"

The first one gives me context, references, and asks for a plan. The second forces me to guess everything.

---

## Maintainer

- Owner: Vlad
- Last AGENTS.md review: <date>
- Next review: weekly during active development
