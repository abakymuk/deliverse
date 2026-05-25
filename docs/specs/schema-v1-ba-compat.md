# Schema v1 — Better-Auth-compatible identity schema

**Status:** Accepted
**Date:** 2026-05-25
**Owner:** Vlad
**Issue:** [DEL-10](https://linear.app/oveglobal/issue/DEL-10/drizzle-schema-v1-better-auth-compatible-identity-schema)
**ADR:** [0007-ba-mapping-strategy.md](../decisions/0007-ba-mapping-strategy.md)

---

## 1. Goal

Finalize `packages/db/src/schema.ts` so every required Better-Auth field on every BA model (`user`, `account`, `session`, `verification`, `organization`, `member`, `invitation`) has a corresponding column the BA `fields` config can map to. Lock the schema before any seed data is written and before DEL-11 wires the BA configs.

Greenfield — the single `0000_strange_stephen_strange.sql` migration is regenerated rather than ALTERed.

## 2. Source of truth

Audit done against the installed BA version, **not docs**:

- `better-auth@1.6.11` per `pnpm-lock.yaml`. The `^1.4.0` range in `packages/auth-core/package.json` is unchanged — no bump in this issue.
- Core model fields: `@better-auth/core/dist/db/get-tables.mjs`.
- Organization plugin fields and session augmentation: `better-auth/dist/plugins/organization/organization.mjs`.
- emailOTP plugin: `better-auth/dist/plugins/email-otp/index.mjs` — piggybacks on `verification` (writes via `createVerificationValue`), no schema additions.

## 3. Mapping strategy (set by ADR 0007)

Map BA → schema. Our column and table names stay; BA is configured to point at them via `fields` and `modelName` in DEL-11. Two BA instances (platform, storefront) coexist over a single DB because each gets its own model→table map.

### 3.1 `fields:` values are Drizzle property keys, not SQL column names

**This is the single biggest footgun.** The Drizzle adapter (`@better-auth/drizzle-adapter@1.6.11`, `dist/index.mjs:89,120,170`) accesses columns as `schemaModel[field]`, where `schemaModel` is the Drizzle table object and `field` is the **value** from BA's `fields:` config. Drizzle table objects expose **JS property keys** (camelCase, as declared in `schema.ts`), not the underlying SQL column names.

Concretely, for `platform_accounts`:

| Layer | Identifier |
|---|---|
| SQL column | `platform_user_id` |
| Drizzle property (`platformAccounts.platformUserId`) | `platformUserId` |
| **BA mapping value** (`fields.userId: '…'`) | **`'platformUserId'`** ← use this |

Using `'platform_user_id'` will throw `BetterAuthError: The field "userId" does not exist in the schema for the model "account"` at runtime.

All 🅿️ entries in §6 are written as the Drizzle property name. DEL-11 copies them verbatim into the `fields:` config.

## 4. Constraints carried forward

These are non-negotiable. Schema v1 preserves all of them:

- **Tenant-scoped end users:** `tenant_end_users` `UNIQUE(tenant_id, email) WHERE deleted_at IS NULL`. NOT relaxed to global uniqueness even though BA's default `user.email` is `unique: true`.
  ⚠️ **The DB constraint is necessary but not sufficient.** Better Auth's default lookup paths (`/sign-in/email-otp`, `/sign-up/email`, account linking, password reset) query `user.email` **without** a `tenant_id` predicate — the DB constraint only prevents duplicate writes, it does not make BA's lookups tenant-aware. Until the storefront BA instance wraps every lookup/create path to inject `tenant_id` (cross-issue work: DEL-3 for tenant resolution + DEL-11 for the wrapped adapter), end-user lookups across tenants are **incorrect by default**: a sign-in attempt for `john@x.com` at Tenant B will match Tenant A's row (or fail the wrong way) depending on which row Postgres returns first. Treat the storefront instance as unsafe to expose to real users until that wrapping ships.
- **Partial unique indexes** for soft delete: `platform_users_email_idx`, `tenants_slug_idx`, `brands_slug_idx`, `tenant_invitations_pending_idx`.
- **Cascade deletes** from parent (tenant → locations, brands, end users, memberships; user → accounts, sessions).
- **`tenant_role` enum** (`owner | manager | staff | viewer`); custom role accessControl matrix is DEL-11's problem.
- **`verification_type` enum** (`otp_login | email_verify | password_reset`); declared as `additionalField` by DEL-11.
- **Storefront-specific session/verification extras:** `current_brand_id` on `tenant_end_user_sessions`; `tenant_id`, `brand_id`, `type`, `attempts` on `tenant_end_user_verifications`. All stay; declared as `additionalFields` by DEL-11.
- **Hybrid auth for end users:** `password` column on `tenant_end_user_accounts` retained.

## 5. Column-level diff (locked)

| # | Table | Change | Rationale |
|---|---|---|---|
| 1 | `platform_users` | drop `email_verified_at TIMESTAMPTZ`; add `email_verified BOOLEAN NOT NULL DEFAULT FALSE` | BA core types `user.emailVerified` as boolean (§7) |
| 2 | `tenant_end_users` | drop `email_verified_at TIMESTAMPTZ`; add `email_verified BOOLEAN NOT NULL DEFAULT FALSE` | Same |
| 3 | `platform_users` | `name TEXT` → `name TEXT NOT NULL` | BA core requires `user.name` (§8) |
| 4 | `tenant_end_users` | `name TEXT` → `name TEXT NOT NULL` | Same |
| 5 | `platform_sessions` | add `active_organization_id UUID NULL REFERENCES tenants(id) ON DELETE SET NULL` | Organization plugin augments `session` with `activeOrganizationId` (§9) |
| 6 | `platform_sessions` | add `index platform_sessions_active_org_idx ON (active_organization_id)` | Supports "list sessions in this org" queries |

Nothing else changes. All other tables, columns, FKs, indexes, enums are byte-for-byte preserved.

## 6. BA field audit

Legend: ✅ matches BA shape directly · 🅿️ mapped via `fields:` config in DEL-11 · ➕ declared as `additionalFields` in DEL-11 · ⛔ deliberately diverges (documented).

### 6.1 Platform instance

Legend reminder: mapping values shown in `fields.X: 'Y'` are **Drizzle property keys** (camelCase), not SQL column names. See §3.1.

#### user → `platform_users`

| BA field | Type | Required | Drizzle property | Mapping | Notes |
|---|---|---|---|---|---|
| `name` | string | yes | `name` | ✅ (same key) | Diff #3 makes notNull |
| `email` | string, unique | yes | `email` | ✅ (same key) | Soft-delete partial unique satisfies the constraint for active rows |
| `emailVerified` | boolean, default false, `input:false` | yes | `emailVerified` | ✅ post-diff (same key) | Diff #1; **drop the current `fields.emailVerified: 'email_verified_at'` mapping** in `auth-core/platform.ts` |
| `image` | string | no | `imageUrl` | 🅿️ `fields.image: 'imageUrl'` | Currently wrongly mapped to `'image_url'` — DEL-11 must change to camelCase |
| `createdAt` | date | yes | `createdAt` | ✅ | |
| `updatedAt` | date | yes | `updatedAt` | ✅ | |
| — | — | — | `deletedAt` | ➕ `additionalFields.deletedAt` (`input:false`) | Already wired |

#### account → `platform_accounts`

| BA field | Type | Required | Drizzle property | Mapping | Notes |
|---|---|---|---|---|---|
| `accountId` | string | yes | `accountId` | ✅ | |
| `providerId` | string | yes | `providerId` | ✅ | |
| `userId` | string FK→user, cascade, indexed | yes | `platformUserId` | 🅿️ `fields.userId: 'platformUserId'` | **Not currently mapped** — DEL-11 must add |
| `accessToken` | string | no | `accessToken` | ✅ | |
| `refreshToken` | string | no | `refreshToken` | ✅ | |
| `idToken` | string | no | `idToken` | ✅ | |
| `accessTokenExpiresAt` | date | no | `accessTokenExpiresAt` | ✅ | |
| `refreshTokenExpiresAt` | date | no | `refreshTokenExpiresAt` | ✅ | |
| `scope` | string | no | `scope` | ✅ | |
| `password` | string | no | `password` | ✅ | bcrypt hash; cost ≥12 in BA config |
| `createdAt` | date | yes | `createdAt` | ✅ | |
| `updatedAt` | date | yes | `updatedAt` | ✅ | |

Unique `(provider_id, account_id)` index retained.

#### session → `platform_sessions`

| BA field | Type | Required | Drizzle property | Mapping | Notes |
|---|---|---|---|---|---|
| `expiresAt` | date | yes | `expiresAt` | ✅ | |
| `token` | string, unique | yes | `token` | ✅ | Unique index present |
| `createdAt` | date | yes | `createdAt` | ✅ | |
| `updatedAt` | date | yes | `updatedAt` | ✅ | |
| `ipAddress` | string | no | `ipAddress` | ✅ | |
| `userAgent` | string | no | `userAgent` | ✅ | |
| `userId` | string FK→user, cascade, indexed | yes | `platformUserId` | 🅿️ `fields.userId: 'platformUserId'` | DEL-11 must add |
| `activeOrganizationId` *(org plugin)* | string, optional | no | `activeOrganizationId` | ✅ post-diff (same key) | Diff #5; FK→tenants, `set null` |

#### verification → `platform_verifications`

| BA field | Type | Required | Drizzle property | Mapping | Notes |
|---|---|---|---|---|---|
| `identifier` | string, indexed | yes | `identifier` | ✅ | Index present. Some BA flows pack flow-specific data here (e.g. `reset-password:${token}`); the column stays plain `text` and the schema does not constrain shape. |
| `value` | string | yes | `value` | ✅ | Storage semantics are BA-flow-specific (not always hashed, not always a token — for password reset in 1.6.x it's the user id). DEL-11 must verify the actual token hashing/storage path for each enabled flow against [auth-spec §12](../auth-spec.md#12-risks). Schema makes no claim about plaintext vs hash. |
| `expiresAt` | date | yes | `expiresAt` | ✅ | |
| `createdAt` | date | yes | `createdAt` | ✅ | |
| `updatedAt` | date | yes | `updatedAt` | ✅ | |

#### organization → `tenants`

| BA field | Type | Required | Drizzle property | Mapping | Notes |
|---|---|---|---|---|---|
| `name` | string | yes | `name` | ✅ | |
| `slug` | string, unique, indexed | yes | `slug` | ✅ (partial-unique index) | Soft-delete invariant |
| `logo` | string | no | `logo` | ✅ | |
| `metadata` | string (BA) | no | `metadata` (jsonb) | ⚠️ type widening — needs DEL-11 verification | BA's `getTables.mjs` types this as `string` and may stringify on write / leave as JSON on read. jsonb is a strict superset on the DB side, but the round-trip through the adapter is not proven for our version. DEL-11 must exercise org create/update with non-trivial metadata and confirm read-back parity. If broken, options: (a) change column to `text` and let BA stringify, (b) add a transform in the adapter wrapper. |
| `createdAt` | date | yes | `createdAt` | ✅ | |
| — | — | — | `status`, `updatedAt`, `deletedAt` | ➕ `additionalFields` (DEL-11) | Business-logic columns |

#### member → `tenant_memberships`

| BA field | Type | Required | Drizzle property | Mapping | Notes |
|---|---|---|---|---|---|
| `organizationId` | string FK→org, indexed | yes | `tenantId` | 🅿️ `fields.organizationId: 'tenantId'` | |
| `userId` | string FK→user, indexed | yes | `platformUserId` | 🅿️ `fields.userId: 'platformUserId'` | |
| `role` | string, default `'member'` | yes | `role` (enum `tenant_role`) | ✅ + enum constraint | Custom roles (`owner`/`manager`/`staff`/`viewer`) wired via `accessControl` in DEL-11 |
| `createdAt` | date | yes | `createdAt` | ✅ | |

`UNIQUE(platform_user_id, tenant_id)` retained.

#### invitation → `tenant_invitations`

| BA field | Type | Required | Drizzle property | Mapping | Notes |
|---|---|---|---|---|---|
| `organizationId` | string FK→org, indexed | yes | `tenantId` | 🅿️ `fields.organizationId: 'tenantId'` | |
| `email` | string, indexed | yes | `email` | ✅ | |
| `role` | string | no | `role` (enum `tenant_role`) | ✅ + enum constraint | |
| `status` | string, default `'pending'` | yes | `status` (text default `'pending'`) | ✅ | |
| `expiresAt` | date | yes | `expiresAt` | ✅ | |
| `createdAt` | date | yes | `createdAt` | ✅ | |
| `inviterId` | string FK→user | yes | `inviterId` | ✅ (same key) | |

Partial unique `(tenant_id, email) WHERE status = 'pending'` retained.

### 6.2 Storefront instance

#### user → `tenant_end_users`

| BA field | Type | Required | Drizzle property | Mapping | Notes |
|---|---|---|---|---|---|
| `name` | string | yes | `name` | ✅ post-diff | Diff #4 |
| `email` | string, unique | yes | `email` | ⚠️ tenant-scoped partial unique | BA's lookup is NOT tenant-aware by default. See §4 warning — storefront unsafe until DEL-3 + DEL-11 wrap every lookup/create path. |
| `emailVerified` | boolean, default false, `input:false` | yes | `emailVerified` | ✅ post-diff (same key) | Diff #2; **drop the current `fields.emailVerified: 'email_verified_at'` mapping** in `auth-core/storefront.ts` |
| `image` | string | no | `imageUrl` | 🅿️ `fields.image: 'imageUrl'` | Currently wrongly mapped to `'image_url'` — DEL-11 must change to camelCase |
| `createdAt` | date | yes | `createdAt` | ✅ | |
| `updatedAt` | date | yes | `updatedAt` | ✅ | |
| — | — | — | `tenantId`, `phone`, `deletedAt` | ➕ `additionalFields` (DEL-11) | `tenantId` is required, `input:false`, injected by tenant resolution (DEL-3) |

#### account → `tenant_end_user_accounts`

Same shape as platform. Mapping: `fields.userId: 'tenantEndUserId'`. `password` retained (hybrid auth).

#### session → `tenant_end_user_sessions`

Same shape as platform `session` minus `activeOrganizationId` (no organization plugin on storefront). Mapping: `fields.userId: 'tenantEndUserId'`. `currentBrandId` stays as ➕ `additionalField` (required, `input:false`).

#### verification → `tenant_end_user_verifications`

Core shape ✅. Drizzle props `tenantId` (required), `brandId` (optional), `type` (enum), `attempts` (default 0) all stay as ➕ `additionalFields`.

### 6.3 Plugins not wired in v1

`organizationRole` (`dynamicAccessControl`), teams (`activeTeamId`, `team`, `teamMember`) — not enabled, no schema additions needed.

## 7. `emailVerified` resolution

BA core declares `user.emailVerified` as:

```ts
{ type: "boolean", defaultValue: false, required: true, input: false }
```

A timestamp column cannot back a boolean field — the type layer breaks on read, and `input:false` makes setter overrides impossible. Schema v1 follows BA's shape verbatim.

**v2 path** if audit semantics ("when did they verify?") are needed:

1. Add a separate `email_verified_at TIMESTAMPTZ` column (no BA mapping).
2. Stamp it via BA `databaseHooks.user.update.after`: when `emailVerified` transitions from `false` to `true`, write `now()`.

This is deferred deliberately. v1 has no consumer for the timestamp.

## 8. `name` notNull

BA core declares `user.name` as required. Today both `platform_users.name` and `tenant_end_users.name` are nullable, which would let BA write rows that violate the core spec — silent type drift and a real runtime risk on the BA→app boundary.

Diff #3 and #4 make both columns `NOT NULL`. Greenfield, so no backfill needed.

**Fallback responsibility** sits in DEL-11's signup paths, not the schema:

- Email+password signup: form requires a name.
- Google OAuth: provider returns `name` ≥99% of the time; on the rare miss, derive from email local-part (`john@x.com` → `john`).
- Email OTP signup (storefront): signup form prompts for name; if omitted, fall back to email local-part.

## 9. `activeOrganizationId` on `platform_sessions`

The organization plugin registers:

```js
session: { fields: { activeOrganizationId: { type: "string", required: false } } }
```

It's the column the plugin reads to resolve "current org" on every request. Without it, every org-scoped endpoint falls back to passing `organizationId` explicitly in the body, which neither the BA client SDK nor our future UI does.

- Type: `uuid`, nullable (sessions exist before any org is selected).
- FK: `tenants(id)`, `ON DELETE SET NULL` — when a tenant is hard-deleted, sessions for users with that tenant active remain valid but unscoped.
- Index: `platform_sessions_active_org_idx` (non-unique) — supports "list sessions in this org" (admin UI, audit, tenant member-removed cleanup per auth-spec §11.10).
- Storefront sessions do **not** get this column; no organization plugin on the storefront instance.

## 10. Migration plan

Greenfield, no prod data, no preserved 0000:

1. Delete `packages/db/migrations/0000_strange_stephen_strange.sql`.
2. Delete `packages/db/migrations/meta/0000_snapshot.json`.
3. **Reset** `packages/db/migrations/meta/_journal.json` to an empty entries list — do **not** delete it. `drizzle-kit generate` opens this file unconditionally and fails with `ENOENT` if it's missing. Write:
   ```json
   {
     "version": "7",
     "dialect": "postgresql",
     "entries": []
   }
   ```
4. Apply schema edits per §5.
5. `pnpm --filter @rp/db generate` → single canonical 0000 (drizzle-kit picks a random suffix; expect a file like `0000_<adjective>_<noun>.sql`). The journal will be repopulated with one entry pointing at the new file.
6. `pnpm typecheck`.
7. `doppler run -- pnpm --filter @rp/db migrate` against an empty Neon dev branch (best-effort; needs Doppler).

If Doppler isn't available in the session, steps 1–6 are sufficient for issue closure; step 7 is verified by Vlad locally.

## 11. Out of scope

- BA `fields` config wiring → DEL-11.
- Tenant injection at storefront signup → DEL-3.
- `lastRequestedAt` rate-limit column → DEL-9 (migration on top of v1).
- Custom role `accessControl` matrix → DEL-11.
- Postgres RLS → deferred (auth-spec §12).
- New dependencies → none. Use `drizzle-orm` + `drizzle-kit` already in lockfile.
- Better-Auth version bump → no.

## 12. Verification checklist

- [ ] `pnpm typecheck` clean.
- [ ] `pnpm --filter @rp/db generate` produces no further diff (idempotent).
- [ ] Single `0000_*.sql` present; old name gone.
- [ ] `pnpm --filter @rp/db migrate` runs cleanly against an empty Neon dev branch *(best-effort, needs Doppler)*.
- [ ] `psql -c '\d+ platform_sessions'` shows `active_organization_id uuid` with FK *(best-effort)*.
- [ ] Drizzle Studio shows all tables, relations resolve *(best-effort)*.
