# 0010 — Storefront tenant scoping via wrapped Drizzle adapter + factory callback

**Date:** 2026-05-26
**Status:** Accepted
**Deciders:** Vlad

## Context

[DEL-3](https://linear.app/oveglobal/issue/DEL-3) needs to close the architecture question for how storefront end-user identity gets tenant-scoped at the Better-Auth layer. Two failure modes existed after DEL-11:

1. **Writes:** the storefront's `tenantId` / `currentBrandId` / `verification.type` `additionalFields` are declared `input: false, required: false`, so BA's `parseInputData` strips any caller-supplied values. DEL-11's `databaseHooks.before` stubs threw a typed `BetterAuthError` on every storefront write — preventing NULL inserts but breaking *every* signup / OTP / OAuth path.
2. **Reads:** [`schema-v1-ba-compat.md` §4](../specs/schema-v1-ba-compat.md#4-constraints-carried-forward) flagged that BA's default lookup paths (`/sign-in/email`, `/sign-up/email`, OTP verify, account linking, password reset) query by `email` / `identifier` *without* a `tenant_id` predicate, so even with writes fixed the storefront leaks identity across tenants by default.

The DEL-11 spec §3 listed three candidate strategies and explicitly punted the choice to DEL-3:

- **A.** `databaseHooks.before` reading `x-brand-slug` → `getBrandContext` → returning `{ data: { tenantId } }`.
- **B.** Custom server actions wrapping `signUp.email` / `emailOtp.signIn` etc., pre-resolving `tenantId` then calling `storefrontAuth.api.X({ body, headers })`.
- **C.** Wrapped Drizzle adapter injecting tenant context below BA's transform layers.

A second decision point appeared during plan review: in any of the three options, the wrapper / hook / server action needs access to per-request context (`Host` header). Either `@rp/auth-core` imports `next/headers` directly (workspace package depending on Next.js), or the package exports a *factory* that takes a request-context resolver as a callback (package stays Next-free).

A third decision point — the `tenant_end_user_accounts(provider_id, account_id)` unique index is *global*. Adapter scoping alone can't fix OAuth account lookup; that needs a schema delta. This ADR scopes that out to DEL-3a.

## Decision

1. **Wrapped Drizzle adapter (option C).** `packages/auth-core/src/storefront-adapter.ts` exports `wrappedStorefrontAdapter(inner, resolveTenantContext)` that intercepts every storefront-scoped method (`create` for `user`/`session`/`verification`; `findOne`/`findMany`/`count`/`update`/`updateMany`/`delete`/`deleteMany`/`consumeOne` for `user`/`verification`) and stamps or filters on `tenant_id` below BA's input-transform layer. See [`docs/specs/storefront-tenant-scoping.md` §5](../specs/storefront-tenant-scoping.md) for the method-by-method contract.
2. **Factory-callback pattern.** `@rp/auth-core/storefront` exports `createStorefrontAuth(resolveTenantContext: () => Promise<{ tenantId: string; brandId: string }>)`. The app constructs the resolver using `next/headers` and passes it in. `@rp/auth-core` declares **zero** Next deps.
3. **`APIError('BAD_REQUEST', ...)` for client-facing failures.** When the resolver can't determine a tenant (missing brand subdomain, unknown slug, inactive brand), it throws `APIError('BAD_REQUEST', { message: ..., code: 'TENANT_CONTEXT_REQUIRED' })`. BA serializes this as HTTP 400, matching the precedent at `node_modules/better-auth/dist/db/schema.mjs:47-50` (`APIError.from("BAD_REQUEST", { ...FIELD_NOT_ALLOWED, ... })`). `BetterAuthError` is reserved for internal/config errors (500-class) — the wrapper does not use it for tenant-context misses.
4. **DEL-11's throw-only `databaseHooks` are deleted.** With the wrapper guaranteeing tenantId on every create path, the hooks are dead code.
5. **`verification.type` derived from `data.identifier`** in a pure helper (`storefront-verification-type.ts`) with source-cited mappings — 4 input patterns, 3 enum values.
6. **`account` model not wrapped — DEL-3a created.** Adapter scoping can't fix the global `(provider_id, account_id)` unique index. DEL-3a adds `tenant_id` to `tenant_end_user_accounts` + adapter scoping + the corresponding migration. **Blocks DEL-7's OAuth signup.**

## Alternatives Considered

### A. `databaseHooks.before` injecting `tenantId`

**Rejected — incomplete.** Earlier framing in DEL-11 spec §4 claimed BA runs `parseInputData` *twice* (once before the hook, once after) and that the second pass rejects hook-injected `input: false` fields. **That framing was incorrect.** Source-verified at `node_modules/better-auth/dist/db/with-hooks.mjs:6-42` + `@better-auth/core/dist/db/adapter/factory.mjs:99-141,410-449`: `parseInputData` runs once at the *route handler* (e.g. `dist/api/routes/sign-up.mjs:162`), and after the hook merges its result into `actualData`, the adapter's `transformInput` does *no* `input: false` re-check — it only does field-name mapping and type coercion. So a hook returning `{ data: { tenantId: 'x' } }` *would* successfully inject the value on writes.

But: hooks don't run on `findOne` / `findMany`. The `schema-v1 §4` lookup invariant requires `findUserByEmail` etc. to be tenant-aware too, which hooks can't provide. Picking option A would leave us with two mechanisms (hooks for writes + something else for reads) when one (the wrapper) covers both.

### B. Custom server actions wrapping `signUp.email` / `emailOtp.signIn`

**Rejected — incomplete + dual-mechanism.** Server actions could pre-resolve `tenantId` and call `storefrontAuth.api.X({ body, headers })` directly. Two problems:

- **OAuth callback bypasses server actions.** Google's redirect lands at `/api/auth/callback/google`, which is the auto-mounted route handler; it calls `internalAdapter.createOAuthUser` (`dist/db/internal-adapter.mjs:56-73`) which goes through the same `createWithHooks` path. A server-action wrapper for `signUp.email` doesn't intercept the OAuth callback. We'd need to *also* wrap the callback — meaning a custom route handler reimplementing BA's OAuth dance, or a parallel hook story just for OAuth. Either way: more code, more places to forget.
- **Doesn't address lookups.** Same as option A — server actions can pre-process the input but they don't intercept BA's internal `findUserByEmail`.

### i. Embed `next/headers` directly in `@rp/auth-core`

**Rejected — dep-direction violation.** Importing `next/headers` from `packages/auth-core/` would make `@rp/auth-core` depend on Next.js. ADR-0009 set the precedent for keeping packages Next-free (the email-delivery package uses a package-local resolver, not the storefront's React-`cached` one). The factory-callback approach respects that boundary at the cost of one extra wiring step in the app.

Pragmatic note: if a future need pulls the resolver into `@rp/auth-core` directly (e.g. an Inngest worker also needs to construct the storefront auth for background tasks), revisit. For now, the app-owned resolver is the right boundary.

### Fix DEL-3a inline (schema migration + adapter scoping for `account`)

**Rejected for DEL-3 — too much surface for one PR.** Adding `tenant_id` to `tenant_end_user_accounts`, recomposing the unique index, adapter-scoping the `account` model, and writing migration tests would roughly double DEL-3's diff and PR review surface. The DEL-3 carve-out (password + email-OTP first, OAuth signup gated on DEL-3a) is the cleaner incremental landing. DEL-3a inherits this ADR's framing and is its own slice.

## Consequences

### Positive

- **Single mechanism for writes + reads.** One file (`storefront-adapter.ts`) owns the entire storefront tenant-scoping contract. Adding a future model to scope is a one-line dispatch-table addition.
- **`input: false` stays on for defense-in-depth.** External HTTP callers cannot spoof `tenantId` / `currentBrandId` / `verification.type` — the wrapper is the *only* path that sets them.
- **`@rp/auth-core` stays Next-free.** Future workers (Inngest, scripts) can construct the storefront BA with a different resolver — e.g. a CLI script can pass a fixed-tenant resolver for backfills.
- **AGENTS.md gotcha is a small, real gain.** "Storefront BA must be constructed via `createStorefrontAuth(...)`" beats "remember to inject `tenant_id` in N places."

### Negative

- **Lookup wrapping adds wire surface to maintain.** When BA 1.6.x → 1.7.x ships, any changes to the `DBAdapter` interface (new methods, signature changes) require updating the wrapper. Mitigated by exhaustive `switch` on model names — TypeScript will catch missing models at upgrade time.
- **One extra DB roundtrip per BA call.** The resolver calls `resolveBrandBySlug(slug)` on every wrapped method invocation. For typical signup (1× user create + 1× session create), that's 2 extra DB calls. Negligible against Neon pooled latency; revisit if measured as a bottleneck (per-request memoization via React `cache` is the obvious next step, but it'd re-introduce a React dep in the package).
- **The DEL-11 spec §4 framing was wrong.** That framing is *referenced* from this ADR but corrected here. Future code archeology will find both — leaving DEL-11 spec untouched (as accepted history) and pointing forward to this ADR for the current truth. (DEL-11 spec is "Accepted" at a moment in time; ADRs supersede.)

### Neutral

- **OAuth account-lookup gap is documented in code via the SCOPE WARNING in `storefront.ts`** with a `// TODO(DEL-3a)` marker. Anyone reading the file sees the open invariant; DEL-7's OAuth-signup work *must not* land before DEL-3a closes.

## Future implications

- **DEL-3a** adds `tenant_id` to `tenant_end_user_accounts` and extends the wrapper to the `account` model. Same factory-callback shape; small spec update.
- **Per-request memoization** of `resolveBrandBySlug` if signup latency is measurable. A WeakMap keyed on the request context (or AsyncLocalStorage) avoids the React-cache dep direction problem.
- **Workspace-level shared brand query** — once a third caller appears (besides `@rp/emails` from ADR-0009 and `@rp/auth-core` from this ADR), promote `resolveBrandBySlug` into `@rp/db/queries/brands.ts` as the single source.
- **Postgres RLS** (auth-spec §12) would replace the application-layer scoping with DB-layer enforcement. The wrapper would then become a thin pass-through; we'd remove its scoping logic but keep the `create`-side stamping. Deferred until we have multi-tenant security requirements beyond what app-layer wrapping provides.

## References

- [DEL-3 issue](https://linear.app/oveglobal/issue/DEL-3).
- [`docs/specs/storefront-tenant-scoping.md`](../specs/storefront-tenant-scoping.md) — implementation spec.
- [`docs/specs/better-auth-config-v1.md`](../specs/better-auth-config-v1.md) §3 + §4 + §8.8 — DEL-11's punted hooks (now removed by this issue) and the original three-option framing.
- [`docs/specs/schema-v1-ba-compat.md`](../specs/schema-v1-ba-compat.md) §4 — the lookup non-scoping warning this ADR closes (modulo the OAuth account-lookup gap).
- [ADR-0009](./0009-emails-package-shape.md) — same "package-local resolver, no Next/React-cache deps in workspace packages" pattern this ADR inherits.
- [ADR-0007](./0007-ba-mapping-strategy.md) — Drizzle property keys vs SQL column names; relevant for any `Where`-clause manipulation in the wrapper.
- `node_modules/better-auth@1.6.11/dist/db/with-hooks.mjs:6-42` — `createWithHooks` flow.
- `node_modules/better-auth@1.6.11/dist/db/schema.mjs:34-89` — `parseInputData` + `parseUserInput`.
- `node_modules/@better-auth/core@1.6.11/dist/db/adapter/factory.mjs:99-141,410-449` — factory `create` + `transformInput` (no `input:false` re-check).
- `node_modules/@better-auth/core@1.6.11/dist/db/adapter/types.d.mts:362-453` — `DBAdapter` interface.
- `node_modules/better-auth@1.6.11/dist/plugins/email-otp/utils.mjs:4-7` — `toOTPIdentifier` shape.
- `node_modules/better-auth@1.6.11/dist/api/routes/password.mjs:66-68` — `reset-password:${token}` identifier.

## Amendments

**2026-05-26 — [DEL-5](https://linear.app/oveglobal/issue/DEL-5):** extended `StorefrontTenantContext` from `{ tenantId, brandId }` to `{ tenantId, brandId, brandSlug }`. The DEL-5 storefront OTP callback needs the brand subdomain slug (not the id) to compose the `email.otp.requested` Inngest event payload, and the closure already has `resolveTenantContext` in scope. Slug is read off `BrandContext.brand.slug` (already resolved by `resolveBrandBySlug`) with zero extra DB calls. Adapter wrapper behavior is unchanged — it still scopes by `tenantId`/`brandId` only; `brandSlug` is consumer-only. Additive non-breaking type change.

**2026-05-26 — [DEL-12](https://linear.app/oveglobal/issue/DEL-12) (formerly DEL-3a):** closes the `account` carve-out from decision #6. `SCOPED_MODELS` now includes `account`; the wrapper stamps `tenantId` on `account.create` and scopes all account reads/mutations via the existing dispatch. Schema migration `0002_polite_ego.sql` adds `tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE` to `tenant_end_user_accounts` and replaces the global `unique(provider_id, account_id)` with a tenant-scoped `unique(tenant_id, provider_id, account_id)`. BA config gains `account.additionalFields.tenantId` in `storefront.ts` so the adapter factory's `transformInput` preserves the wrapper-injected field. **Divergence from DEL-12 AC:** no `deleted_at` column added on `tenant_end_user_accounts` — YAGNI for a cascade-delete-only table (accounts cascade-delete with their user; no soft-delete UX exists). Plain unique index, no `WHERE` clause. DEL-7 OAuth signup is now unblocked. See [`docs/specs/del-12-account-tenant-scoping.md`](../specs/del-12-account-tenant-scoping.md).
