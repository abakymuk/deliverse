# Seed data v1 — admin + tenant + brands + locations + dark-kitchen link

**Status:** Accepted
**Date:** 2026-05-25
**Owner:** Vlad
**Issue:** [DEL-1](https://linear.app/oveglobal/issue/DEL-1/seed-script-admin-tenant-2-brands-2-locations-dark-kitchen-link)
**Builds on:** [`schema-v1-ba-compat.md`](./schema-v1-ba-compat.md) (schema columns + partial unique invariants), [`better-auth-config-v1.md`](./better-auth-config-v1.md) (platform `emailAndPassword` config and credential-account shape)

---

## 1. Goal

Replace [packages/db/src/seed.ts](../../packages/db/src/seed.ts) (today: all TODOs) with an **idempotent** script that produces the bootstrap dataset every other Phase 0 / Phase 1 workstream depends on:

- 1 platform admin (`admin@test.local`) with a Better-Auth-compatible credential account
- 1 tenant (`hospitality-group`) with the admin as `owner`
- 2 brands (`pizza-express`, `burger-heaven`) — both under the tenant
- 2 locations (`Downtown Kitchen`, `Eastside Kitchen`) — both under the tenant
- 2 `location_brands` rows demonstrating the dark-kitchen M:N pattern (Downtown serves both brands)

The script must succeed with the same dataset on every run, including consecutive runs against the same DB.

## 2. Source of truth

- **Linear issue:** [DEL-1](https://linear.app/oveglobal/issue/DEL-1) — dataset + AC.
- **Schema:** [packages/db/src/schema.ts](../../packages/db/src/schema.ts) — every NOT NULL column the seed must supply.
- **Partial unique invariants:** [`schema-v1-ba-compat.md` §4](./schema-v1-ba-compat.md#4-constraints-carried-forward) — `platform_users_email_idx`, `tenants_slug_idx`, `brands_slug_idx` are all `WHERE deleted_at IS NULL`. Drives the idempotency strategy in §6.
- **BA credential shape:** read from BA 1.6.11 source, **not** schema.ts comments. The `// 'credentials' | 'google'` hint at [packages/db/src/schema.ts:159](../../packages/db/src/schema.ts:159) is stale. Actual writes: `providerId: 'credential'` (singular), `accountId: createdUser.id`, `password: hashPassword(plaintext)` — verified against `node_modules/better-auth/dist/api/routes/sign-up.mjs`.
- **Password hashing:** `hashPassword` from `@better-auth/utils/password`. The package ships both Node and browser exports; under `tsx` the import resolves to the Node export, which uses `node:crypto` scrypt. Storage shape: `${salt}:${derivedKey}` (colon-separated hex). Verifies bit-exactly via BA's `verifyPassword`.

## 3. Scope framing

DEL-1 unblocks:
- DEL-2 — shadcn login forms now have a real admin to sign in as.
- DEL-3 — storefront tenant injection has a real `hospitality-group` tenant + `pizza-express` brand to resolve.
- DEL-8 — E2E in CI has a deterministic dataset to drive Playwright with.

Explicitly **out of scope** (§8):
- End-user (`tenant_end_users`) rows — Phase 1, created through the real signup flow.
- OTP / verification rows — DEL-5/9.
- CI integration — DEL-8.
- Adding a unique index to `locations` — out of scope (the seed compensates with deterministic UUID constants, see §6).

## 4. Decisions

| # | Decision | Rationale |
|---|---|---|
| 1 | **All inserts use raw Drizzle, including the admin.** The BA-API path (`platformAuth.api.signUpEmail`) would require `packages/db → @rp/auth-core → @rp/db`, a real module-level cycle that breaks `tsc`. | Cleanest dep graph; keeps the seed at the file path DEL-1 names. |
| 2 | **Hash via `hashPassword` from `@better-auth/utils/password`.** Add `@better-auth/utils@0.4.0` as a `packages/db` `devDependency` (already transitive via `better-auth`; declaring it makes the import legal under pnpm's strict-peers). | Stays bit-exact with BA's `verifyPassword` path; future BA KDF changes force a re-pin, no silent drift. |
| 3 | **Idempotency: natural-key `onConflictDoNothing` everywhere except `locations`, which uses deterministic UUID constants.** `locations` has only a non-unique `tenant_id` index — no natural unique key — so the seed declares `const DOWNTOWN_LOCATION_ID` / `const EASTSIDE_LOCATION_ID` UUID strings and conflicts against the PK. Every other table has either a partial-unique or full-unique constraint we can target. | Re-runs never duplicate, never error. |
| 4 | **Admin is `emailVerified: true` at insert.** | Skips the verification email flow (DEL-4/5/6 not landed) so the admin login path works out of the box. Real users go through the standard flow. |
| 5 | **Admin password from a single source constant**, overridable via `SEED_ADMIN_PASSWORD` env. Default: `Admin-Dev-Pass-1` (≥12 chars per platform `emailAndPassword.minPasswordLength: 12`). | This is a dev-only local credential, documented in README + spec — not a secret. AGENTS.md "secrets live in Doppler" applies to real secrets. |
| 6 | **Membership inserted explicitly** as `(admin.id, hospitality-group.id, role='owner')`. The org plugin's `creatorRole: 'owner'` default never fires because we never call `createOrganization`. | Matches the role we wired into DEL-11's `createAccessControl`. |
| 7 | **README addition is just a "Seeded data" callout.** The `/etc/hosts` block already lives at [README.md:49-55](../../README.md). | No duplication. |
| 8 | **Smoke check is "brand context resolves," not "themed landing page paints."** | Storefront landing UI is pre-DEL-2. `getBrandContext('pizza-express') !== null` is verifiable today; visual paint isn't. |

## 5. Dataset

### 5.1 Admin identity

```ts
// platform_users
{
  email: 'admin@test.local',
  name: 'Admin',
  emailVerified: true,
}

// platform_accounts (BA credential shape — providerId singular, accountId = user.id)
{
  platformUserId: admin.id,
  providerId: 'credential',
  accountId: admin.id,
  password: await hashPassword(process.env.SEED_ADMIN_PASSWORD ?? 'Admin-Dev-Pass-1'),
}
```

### 5.2 Tenant + brands + locations

```ts
// tenants
{
  slug: 'hospitality-group',
  name: 'Hospitality Group',
  status: 'active',
}

// tenant_memberships
{
  platformUserId: admin.id,
  tenantId: tenant.id,
  role: 'owner',
}

// brands (×2)
{ tenantId: tenant.id, slug: 'pizza-express',  name: 'Pizza Express',  isActive: true, brandingJson: {} }
{ tenantId: tenant.id, slug: 'burger-heaven',  name: 'Burger Heaven',  isActive: true, brandingJson: {} }

// locations (×2) — IDs are top-level const UUIDs declared in the seed file
const DOWNTOWN_LOCATION_ID = '00000000-0000-4000-8000-000000000001';
const EASTSIDE_LOCATION_ID = '00000000-0000-4000-8000-000000000002';

{ id: DOWNTOWN_LOCATION_ID, tenantId: tenant.id, name: 'Downtown Kitchen', addressLine1: '100 Main St',  city: 'Brooklyn', state: 'NY', postalCode: '11201', country: 'US' }
{ id: EASTSIDE_LOCATION_ID, tenantId: tenant.id, name: 'Eastside Kitchen', addressLine1: '250 East Ave', city: 'Brooklyn', state: 'NY', postalCode: '11215', country: 'US' }

// location_brands (×2 — dark-kitchen shape: Downtown serves BOTH brands)
{ locationId: DOWNTOWN_LOCATION_ID, brandId: pizzaExpress.id }
{ locationId: DOWNTOWN_LOCATION_ID, brandId: burgerHeaven.id }
```

The seed deliberately does not link `Eastside Kitchen` to a brand in v1 — keeping the asymmetry makes "Downtown is the dark kitchen" obvious from the data without extra commentary. DEL-2 / DEL-8 can extend this if needed.

## 6. Idempotency strategy

**Partial unique indexes** (`platform_users.email`, `tenants.slug`, `brands.slug` — all `WHERE deleted_at IS NULL`): Postgres does **not** match a generic `ON CONFLICT (slug)` against a partial unique index. Two clean options:

1. **`.onConflictDoNothing()` with no `target`** — Postgres resolves against any matching constraint, including partial uniques. Simplest.
2. Explicit `target` + `targetWhere: isNull(deletedAt)` matching the partial predicate.

The seed picks **option 1** for partial-unique tables to keep the code boring. Drizzle supports the no-arg form.

**Full unique / composite uniques** (`platform_accounts (provider_id, account_id)`, `tenant_memberships (platform_user_id, tenant_id)`, `location_brands` PK): explicit `.onConflictDoNothing({ target: [<columns>] })`.

**Locations**: `.onConflictDoNothing({ target: locations.id })` against the seed's deterministic UUID constants.

After each insert, read the row's `id` back with a `SELECT … WHERE <natural key> LIMIT 1` — works whether the insert added a row or skipped it. Downstream FK columns use those read-back IDs.

**Critical:** for the three partial-unique tables (`platform_users.email`, `tenants.slug`, `brands.slug`), the read-back predicate **must include `isNull(deletedAt)`** alongside the natural key — e.g. `where(and(eq(platformUsers.email, ADMIN_EMAIL), isNull(platformUsers.deletedAt)))`. The uniqueness invariant on these tables is "active row only," so without the `deletedAt IS NULL` clause a future soft-deleted seed row could be selected and its stale `id` fed into downstream FKs. The full/composite-unique read-backs (accounts, memberships, location_brands, locations) don't carry `deleted_at` columns and don't need this clause.

## 7. Files that change

- [packages/db/src/seed.ts](../../packages/db/src/seed.ts) — implement against §5 + §6. Imports `db` from `./client`, schema tables from `./schema`, `hashPassword` from `@better-auth/utils/password`. Single async `seed()` function, dependency-order inserts, `console.info` summary line at the end (`Seeded admin=…, tenant=…, brands=[…], locations=[…]`). `console.error` for failures. **No `console.log`** per AGENTS.md.
- [packages/db/package.json](../../packages/db/package.json) — add `@better-auth/utils@0.4.0` to `devDependencies`. `db:seed` script and `tsx` devDependency already present; no change there.
- [README.md](../../README.md) — add a short "Seeded data" subsection after the existing "Local subdomain setup" block (~line 56). One paragraph + bulleted list of what `pnpm db:seed` creates. Reference this spec.

## 8. Out of scope

- End-user (`tenant_end_users`) signup data — Phase 1.
- Real OTP / Resend email integration — [DEL-4](https://linear.app/oveglobal/issue/DEL-4) / [DEL-5](https://linear.app/oveglobal/issue/DEL-5) / [DEL-6](https://linear.app/oveglobal/issue/DEL-6).
- OTP rate limiting (`attempts` consumer) — [DEL-9](https://linear.app/oveglobal/issue/DEL-9).
- CI integration (seeded Playwright DB) — [DEL-8](https://linear.app/oveglobal/issue/DEL-8).
- Adding a unique index to `locations` — schema change, separate issue if needed.
- Touching `packages/auth-core/*` — DEL-11's surface stays untouched; the seed talks to the DB directly.
- Any migration file — DEL-1 inserts into the existing post-DEL-10 schema; no `0002_*` needed.

## 9. Verification checklist

Best-effort smoke tests:

- [ ] `pnpm -r typecheck` clean across the workspace.
- [ ] `doppler run -- pnpm db:seed` succeeds with no errors. Logs one summary line via `console.info`.
- [ ] Re-run `doppler run -- pnpm db:seed` immediately — succeeds again, identical summary, no `duplicate key value` errors. *(Confirms `onConflictDoNothing` covers every unique constraint touched.)*
- [ ] `doppler run -- sh -c 'psql "$DATABASE_URL" -c "select (select count(*) from platform_users) as users, (select count(*) from tenants) as tenants, (select count(*) from brands) as brands, (select count(*) from locations) as locations, (select count(*) from location_brands) as location_brands"'` — returns `1 | 1 | 2 | 2 | 2`. The `sh -c '…'` wrapper is required: `doppler run -- psql $DATABASE_URL` would expand `$DATABASE_URL` in the *outer* shell **before** Doppler injects the env, so psql would receive an empty connection string. Scalar subqueries are also required; a comma-list `from a, b, c, …` would produce a Cartesian-product count. *(Best-effort — needs DB connectivity.)*
- [ ] `doppler run -- pnpm dev` starts both apps with no errors. *(Best-effort.)*
- [ ] `curl -H 'x-brand-slug: pizza-express' http://localhost:3001/` returns a 2xx page rendering the brand context. Confirms `getBrandContext('pizza-express')` resolves against the JOIN at [apps/storefront/src/lib/tenant-resolution.ts:73-97](../../apps/storefront/src/lib/tenant-resolution.ts). *(Best-effort.)* — Note: do **not** test via `-H 'Host: pizza-express.localhost:3001'` against the Next.js dev server; the dev server doesn't propagate the spoofed `Host` header to the storefront proxy reliably, so the curl returns 404 even when the seed data is correct. The `x-brand-slug` override is the team's intended dev-only override. The real production path (browser → `*.deliverse.app` subdomain) is unaffected.
- [ ] Sign-in roundtrip via `curl -X POST http://localhost:3000/api/auth/sign-in/email -H 'Content-Type: application/json' -d '{"email":"admin@test.local","password":"Admin-Dev-Pass-1"}'` against the running dev server — returns a session token. Confirms the raw-inserted scrypt hash is `verifyPassword`-compatible with BA's read path. *(Best-effort.)*
