# Storefront tenant-scoped adapter — `tenant_id` injection + lookup scoping

**Status:** Accepted
**Date:** 2026-05-26
**Owner:** Vlad
**Issue:** [DEL-3](https://linear.app/oveglobal/issue/DEL-3)
**ADR:** [`0010-tenant-scoping-injection.md`](../decisions/0010-tenant-scoping-injection.md)
**Blocked by:** [DEL-10](https://linear.app/oveglobal/issue/DEL-10) ✓, [DEL-11](https://linear.app/oveglobal/issue/DEL-11) ✓, [DEL-1](https://linear.app/oveglobal/issue/DEL-1) ✓
**Builds on:** [`better-auth-config-v1.md`](./better-auth-config-v1.md) §3 + §4 + §8.8 (punted hooks); [`schema-v1-ba-compat.md`](./schema-v1-ba-compat.md) §4 (lookup non-scoping warning)
**Implementation issues:** [DEL-7](https://linear.app/oveglobal/issue/DEL-7) (unblocked for non-OAuth; OAuth blocked on DEL-3a)

---

## 1. Goal

Make the storefront Better-Auth instance (`packages/auth-core/src/storefront.ts`) safe to expose to real end users by wrapping the Drizzle adapter with a thin layer that:

- **stamps** `tenant_id`, `current_brand_id`, `verification.brand_id`, and `verification.type` on every storefront `create` for `user` / `session` / `verification` models,
- **scopes** every storefront `findOne` / `findMany` / `count` / `update` / `updateMany` / `delete` / `deleteMany` / `consumeOne` for `user` (by email) and `verification` (by tenant + identifier) to the *current* request's tenant,
- **rejects with HTTP 400** any storefront BA request that arrives without a resolvable brand subdomain.

After DEL-3 ships, the storefront BA instance is no longer "documented as unsafe to expose" ([`schema-v1-ba-compat.md` §4](./schema-v1-ba-compat.md#4-constraints-carried-forward)), with one explicit carve-out: OAuth account lookup. See §10.

## 2. Source of truth

Audit done against installed BA, **not docs**:

- `better-auth@1.6.11` per `pnpm-lock.yaml`.
- `@better-auth/core@1.6.11` — adapter factory + types.
- `@better-auth/drizzle-adapter@1.6.11` — actual Drizzle adapter implementation.
- All file references in §4 + §5 are relative to the installed BA dist trees and cite the exact lines that justify the choice.

## 3. Scope framing — what changed since DEL-11 + the spec §3 punt

DEL-11's spec §3 listed three candidate strategies for tenant injection on writes (hook injection, custom server actions, wrapped adapter) and explicitly punted the choice to DEL-3. The plan-review on DEL-3 then expanded the scope further: writes-only is *not enough* to make the storefront safe — `schema-v1-ba-compat.md` §4 already warned that BA's lookup paths aren't tenant-aware, and write-side injection doesn't address that. DEL-3 covers **reads + writes** for the storefront-scoped models.

**Linear AC #3** (proxy's `x-brand-slug` reaching the BA route handler) is **superseded by Host-based resolution.** The wrapper reads `Host` via `await headers().get('host')` in the app-owned resolver factory — the injected `x-brand-slug` header is *not* required to reach `/api/auth/*`, and the existing proxy intentionally short-circuits `/api/*` per [`proxy.ts:33-35`](../../apps/storefront/src/proxy.ts). The Playwright integration test (§7 test 1) uses `Host: pizza-express.localhost:3001` directly as the executable proof.

## 4. Decisions (BA 1.6.11 source-verified)

| # | Decision | Rationale | BA source |
|---|---|---|---|
| 1 | **Wrap the Drizzle adapter** rather than inject via `databaseHooks.before`. | Hook injection *would* work for writes (parseInputData runs once at the route, not after hooks; `transformInput` in the adapter factory does no `input: false` re-check). But hooks can't scope `findOne` / `findMany` — those bypass hooks entirely. The wrapper handles both with one mechanism, and lets us **keep `input: false`** on every storefront-scoped field for defense-in-depth. | `dist/db/with-hooks.mjs:6-42` (hooks merge, then call `adapter.create({forceAllowId: true})`); `@better-auth/core/dist/db/adapter/factory.mjs:410-449` (factory `create` calls `transformInput` lines 99-141, **no** `parseInputData`); `dist/api/routes/sign-up.mjs:162` (only call site of `parseUserInput` for signup) |
| 2 | **Factory-callback pattern.** `@rp/auth-core/storefront` exports `createStorefrontAuth(resolveTenantContext)`; the app injects a Next-aware resolver. | Keeps `@rp/auth-core` Next-free (ADR-0009's dep-direction principle). The resolver lives in `apps/storefront/src/lib/storefront-tenant-context.ts` and uses `next/headers#headers()` there. | n/a (workspace policy) |
| 3 | **Resolver throws `APIError('BAD_REQUEST', ...)` on missing/invalid tenant context.** | `APIError` is BA's client-facing 400-class error, used by `parseInputData` itself for the parallel "field not allowed" case. BA serializes it as a structured JSON 400 to the HTTP layer. Internal invariant breaks in the wrapper still throw `BetterAuthError` (500-class) — separate concern. | `dist/db/schema.mjs:47-50` (`APIError.from("BAD_REQUEST", { ...FIELD_NOT_ALLOWED, message })` precedent); `@better-auth/core/dist/error.d.mts` (export site) |
| 4 | **Drop DEL-11's throw-only `databaseHooks`** on the storefront — wrapper guarantees the fields. | DEL-11 stubbed hooks as defense against missed wiring. With the wrapper guaranteeing tenantId on every create path, the hooks become dead code; remove. | `packages/auth-core/src/storefront.ts:157-197` (the stub being removed) |
| 5 | **`verification.type` is derived from `data.identifier`** at create time. | BA's emailOTP plugin uses `toOTPIdentifier(type, email)` → `${type}-otp-${email}` where `type ∈ {'sign-in', 'email-verification', 'forget-password'}`. The non-OTP password-reset route uses `reset-password:${token}`. Email-verification (non-OTP) goes through JWT URLs and writes no verification row. So 4 input patterns → 3 enum values. | `dist/plugins/email-otp/utils.mjs:4-7` (`toOTPIdentifier`); `dist/plugins/email-otp/routes.mjs:17-19` (the three types); `dist/api/routes/password.mjs:66-68` (`reset-password:${token}`); `dist/api/routes/email-verification.mjs:12-34` (JWT URL — no DB row) |
| 6 | ~~**`account` model NOT wrapped** in DEL-3.~~ **Closed by DEL-12 (formerly DEL-3a):** `SCOPED_MODELS` extended to `{ user, verification, account }`. Schema migration `0002_polite_ego.sql` adds `tenant_id` + replaces the global unique with `(tenant_id, provider_id, account_id)`. See [`del-12-account-tenant-scoping.md`](./del-12-account-tenant-scoping.md). | `packages/db/src/schema.ts:545-580` |

## 5. The wrapped adapter — method-by-method contract

`packages/auth-core/src/storefront-adapter.ts` exports `wrappedStorefrontAdapter(inner, resolveTenantContext)`. Methods follow the [`DBAdapter` interface](file:///private/var/.../%40better-auth/core/dist/db/adapter/types.d.mts) at `@better-auth/core/dist/db/adapter/types.d.mts:362-453`.

### 5.1 Writes (stamping)

| Model | Method | Behavior |
|---|---|---|
| `user` | `create` | inject `tenantId: ctx.tenantId` into `data` before delegating to `inner.create`. |
| `session` | `create` | inject `currentBrandId: ctx.brandId`. |
| `verification` | `create` | inject `tenantId: ctx.tenantId`, `brandId: ctx.brandId`, `type: deriveVerificationType(data.identifier)`. Throws `APIError('BAD_REQUEST', { message: 'unknown verification identifier shape: …', code: 'UNKNOWN_VERIFICATION_TYPE' })` if the identifier doesn't match any known BA convention — guards against silent enum-failure when BA adds new verification flows in a future minor. |

### 5.2 Reads / mutations (scoping)

The wrapper appends a tenant predicate to the `where` array (using `Where` shape from `@better-auth/core/dist/db/adapter/types.d.mts:291-310`).

| Model | Methods wrapped | Predicate added | Pass-through cases |
|---|---|---|---|
| `user` | `findOne`, `findMany`, `count`, `update`, `updateMany`, `delete`, `deleteMany`, `consumeOne` | **Always** `{ field: 'tenantId', value: ctx.tenantId, operator: 'eq', connector: 'AND' }`. Even on `id`-based lookups (where the predicate is a no-op for matching rows) — keeping the rule unconditional avoids "did the where clause reference `email`?" branching that's fragile across BA versions. | n/a — all user reads/mutations scoped. |
| `verification` | `findOne`, `findMany`, `count`, `update`, `updateMany`, `delete`, `deleteMany`, `consumeOne` | **Always** `{ field: 'tenantId', value: ctx.tenantId, operator: 'eq', connector: 'AND' }` — identifier alone is not tenant-unique. This closes the `consumeVerificationValue` cross-tenant leak (BA does `findMany({identifier})` then `deleteMany({identifier})` at `dist/db/internal-adapter.mjs:673,693`). | n/a — all verification reads/mutations scoped. |
| `session` | `findOne` by `token` | None — token UUIDs are globally unique. | All. |
| `account` | `findOne`, `findMany`, `count`, `update`, `updateMany`, `delete`, `deleteMany`, `consumeOne` | **Always** `{ field: 'tenantId', value: ctx.tenantId, operator: 'eq', connector: 'AND' }` (since DEL-12). Closes the OAuth cross-tenant linking gap — `findOne` by `(providerId, accountId)` only matches accounts in the current tenant. | n/a — all account reads/mutations scoped. |

### 5.3 Failure paths

| Trigger | Wrapper behavior | HTTP outcome |
|---|---|---|
| `resolveTenantContext()` throws `APIError('BAD_REQUEST', ...)` | Propagate. | 400 JSON `{ message, code: 'TENANT_CONTEXT_REQUIRED' }` |
| `deriveVerificationType()` returns `null` (unknown identifier shape) | Wrapper throws `APIError('BAD_REQUEST', ...)`. | 400 JSON `{ message, code: 'UNKNOWN_VERIFICATION_TYPE' }` |
| `model` is one of the storefront-scoped models but the wrapper's internal dispatch table is missing (impossible by construction — guarded by exhaustive `switch`) | `BetterAuthError`. | 500 (internal) |

## 6. `deriveVerificationType(identifier)` map

```
sign-in-otp-<email>            →  'otp_login'
email-verification-otp-<email> →  'email_verify'
forget-password-otp-<email>    →  'password_reset'
reset-password:<token>         →  'password_reset'
(anything else)                →  null   (wrapper throws)
```

Lives in `packages/auth-core/src/storefront-verification-type.ts` as a pure function with a scratch script (`scratch/verification-type-check.ts`) covering the 4 positive cases + 2 negative cases (empty identifier, unknown prefix).

## 7. Verification (AC #4 + #5)

### 7.1 Playwright integration tests — `apps/storefront/tests/e2e/storefront-tenant-scoping.spec.ts`

Driven via Playwright's `request` fixture against `pizza-express.localhost:3001` / `burger-heaven.localhost:3001` / `other-brand.localhost:3001` (test-only second tenant). DB assertions via `@rp/db`. Each test uses nonced emails for rerun safety.

1. **AC #4 positive** — signup at pizza-express stamps Hospitality Group's `tenant_id` on `tenant_end_users`, pizza-express UUID on `tenant_end_user_sessions.current_brand_id`.
2. **AC #4 sibling-brand** — same email at burger-heaven (same tenant) returns 422 `USER_EXISTS`; `count(*) WHERE email = $1 AND deleted_at IS NULL` stays at 1.
3. **AC #4 cross-tenant** — `beforeAll` inserts `Other Co` tenant + `other-brand` brand via `@rp/db`. Signup at other-brand with the *same email* succeeds (200). `count(*)` = 2; tenants set = {Hospitality Group, Other Co}. This is the strong proof the schema-v1 §4 lookup-isolation invariant is held.
4. **AC #5 negative** — POST `/api/auth/sign-up/email` with `Host: localhost:3001` (no brand subdomain) returns 4xx with body matching `/no resolvable tenant/i` and `code: 'TENANT_CONTEXT_REQUIRED'`; `count(*) WHERE email = $1` = 0.

### 7.2 Smoke / unit (best-effort)

- [ ] `pnpm typecheck` clean across workspace.
- [ ] `pnpm --filter @rp/auth-core exec tsx scratch/verification-type-check.ts` — 6/6 cases pass.
- [ ] `pnpm --filter @rp/auth-core exec tsx scratch/origin-check.ts` — regression check, must still pass.
- [ ] `doppler run -- pnpm dev` boots cleanly, zero BA startup errors.
- [ ] Manual visit `http://pizza-express.localhost:3001/login` → request OTP → grep dev logs for `[DEV] OTP for …` → confirm a row in `tenant_end_user_verifications` with `tenant_id = Hospitality Group UUID`, `brand_id = pizza-express UUID`, `type = 'otp_login'`.

## 8. Files touched

### New

- `packages/auth-core/src/storefront-host.ts` — pure `extractBrandSlug(host, baseDomain)`. Moved from `apps/storefront/src/lib/tenant-resolution.ts`.
- `packages/auth-core/src/storefront-tenant-resolver.ts` — `resolveBrandBySlug(slug)` over `@rp/db` (no React `cache()`). Returns `{ brand, tenant } | null`.
- `packages/auth-core/src/storefront-verification-type.ts` — `deriveVerificationType(identifier)` per §6.
- `packages/auth-core/src/storefront-adapter.ts` — `wrappedStorefrontAdapter(inner, resolveTenantContext)`.
- `packages/auth-core/scratch/verification-type-check.ts` — scratch script (matches `scratch/origin-check.ts` shape).
- `apps/storefront/src/lib/storefront-tenant-context.ts` — Next-aware `resolveStorefrontTenantContext()`. Reads `await headers()`, extracts slug, calls `resolveBrandBySlug`. Throws `APIError('BAD_REQUEST', { message: \`no resolvable tenant for storefront request — host=<sanitized>\`, code: 'TENANT_CONTEXT_REQUIRED' })` on any failure.
- `apps/storefront/tests/e2e/storefront-tenant-scoping.spec.ts` — Playwright spec per §7.1.

### Edit

- `packages/auth-core/src/storefront.ts` — refactor from "exports `storefrontAuth`" to "exports `createStorefrontAuth(resolveTenantContext)`". Body wraps `inner = drizzleAdapter(db, {...})` with `wrappedStorefrontAdapter(inner, resolveTenantContext)`. Delete throw-only hooks.
- `apps/storefront/src/lib/auth.ts` — `export const auth = createStorefrontAuth(resolveStorefrontTenantContext)`.
- `apps/storefront/src/lib/tenant-resolution.ts` — `extractBrandSlug` becomes a re-export from `@rp/auth-core/storefront-host`. `getBrandContext` (React-cached) stays.
- `packages/auth-core/package.json` — add export paths for the new modules.
- `AGENTS.md` — bump M1 current focus; add gotcha about `createStorefrontAuth` mandatory wrapper.

## 9. Out of scope (deferred, with explicit owners)

- **DEL-3a** (new): tenant-scope `tenant_end_user_accounts` for OAuth account lookup. Add `tenant_id` column + recompose unique to `(tenant_id, provider_id, account_id)` + wrap `account` model in the adapter. **Blocks DEL-7 OAuth signup.** Created when DEL-3's PR opens.
- **DEL-9:** OTP rate-limit consumer (`attempts` column wiring).
- **DEL-5 / DEL-6:** real Resend email send (stubs stay).
- **DEL-7:** signup pages + cross-brand disclosure — non-OAuth flows unblocked by this issue.
- Cross-tenant *account linking* policy — auth-spec §7 forbids; reaffirmed.
- Postgres RLS — auth-spec §12, deferred.

## 10. Known limitations after DEL-3 ships

~~**OAuth account lookup remains globally scoped.**~~ **Closed by [DEL-12](https://linear.app/oveglobal/issue/DEL-12)** (2026-05-26): schema migration `0002_polite_ego.sql` adds `tenant_id` to `tenant_end_user_accounts` and recomposes the unique index. The storefront BA instance is now safe to expose for **all** flows including Google OAuth signup/signin. DEL-7's OAuth gate can be lifted.

## 11. Amendments

**2026-05-26 — [DEL-5](https://linear.app/oveglobal/issue/DEL-5):** `StorefrontTenantContext` extended from `{ tenantId, brandId }` to `{ tenantId, brandId, brandSlug }`. The storefront OTP send callback closes over `resolveTenantContext` and needs the slug (not the id) for the Inngest event payload. Adding the field to the existing context type avoids a sibling resolver callback (would double the per-request DB plumbing) and a second DB lookup (the slug is already on the resolved `BrandContext.brand.slug`). Wrapper behavior is **unchanged** — it still scopes by `tenantId`/`brandId` only; `brandSlug` is consumer-only. See [`docs/specs/otp-email.md`](./otp-email.md) §7 for the consumer.

**2026-05-26 — [DEL-12](https://linear.app/oveglobal/issue/DEL-12) (formerly DEL-3a):** account-model scoping shipped. `SCOPED_MODELS` extended to include `account`; wrapper now stamps `tenantId` on `account.create` and scopes account reads/mutations via the existing dispatch. Schema migration `0002_polite_ego.sql` adds `tenant_id` to `tenant_end_user_accounts` (backfilled from the FK user row pre-`SET NOT NULL`) and replaces the global `unique(provider_id, account_id)` with a tenant-scoped `unique(tenant_id, provider_id, account_id)`. BA config gains `account.additionalFields.tenantId` in `storefront.ts` so the factory's `transformInput` preserves the wrapper-injected field. **Divergence from DEL-12 AC:** no `deleted_at` column / partial index — YAGNI on a cascade-delete-only table; plain unique. See [`del-12-account-tenant-scoping.md`](./del-12-account-tenant-scoping.md). §6 row #6 + §10 OAuth limitation are now resolved.
