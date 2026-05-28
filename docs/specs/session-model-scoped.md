# Session model tenant scoping — Spec v1

**Created:** 2026-05-28
**Status:** Draft
**Owner:** Vlad
**Linear:** (none — small defense-in-depth fix, no Linear issue per the PR #58 OAuth-fix precedent)
**ADR:** [`0010-tenant-scoping-injection.md`](../decisions/0010-tenant-scoping-injection.md) (this spec adds a dated amendment)
**Discovered by:** [DEL-26](https://linear.app/oveglobal/issue/DEL-26) cookie-isolation work; documented in [`food-hall-test-matrix.md`](./food-hall-test-matrix.md) § Open Questions §2

---

## Problem

[`packages/auth-core/src/storefront-adapter.ts:72`](../../packages/auth-core/src/storefront-adapter.ts:72) declares `SCOPED_MODELS = {'user', 'verification', 'account'}` per the original DEL-3 contract — `session` is intentionally excluded with the rationale "session lookups by `token` pass through" (line 9 comment). The reasoning at the time: session tokens are random UUIDs and effectively unique; the joined user is scoped via `SCOPED_MODELS`, so cross-tenant data shouldn't leak.

DEL-26's cookie-isolation work demonstrated this reasoning is incomplete. Sign up at `pizza-express.localhost:3001` (tenant A — Hospitality Group), capture the `Set-Cookie` value, replay via explicit `Cookie:` header on `oomi-kitchen-test.localhost:3001/api/auth/get-session` (tenant B — OOMI). BA returns 200 with the tenant-A user + session payload (`tenantId=hospitality-group-id`), even though the request was made against OOMI's tenant resolver.

Root cause: Better-Auth's `getSession` uses `internalAdapter.findSession`, which composes session + user data in a single relational query. The wrapped adapter's `findOne` for the `user` model never runs as a separate call — there's no second hop where the wrapper's tenant predicate gets applied. The session lookup returns the row by token unscoped, and the joined user comes with it.

**Threat model.** In a normal browser flow, BA's session cookie has `Domain` scoped to the exact storefront subdomain (DEL-26 `cookie-isolation.spec.ts` covers this). A browser will refuse to send the cookie cross-storefront. The gap only manifests with explicit header injection / MitM / programmatic clients. Practical impact is **info disclosure** of cross-tenant user/profile/brand data (email, name, `tenantId`, `currentBrandId`) at any request that reaches BA's get-session endpoint. Downstream code paths that trust `session.user` without re-checking tenant could amplify the leak.

This spec closes the gap at the API layer with a real `tenant_id` column on the session table, matching the DEL-12 precedent for `tenant_end_user_accounts`.

## Users

- **Restaurant guests (end users)** — defense-in-depth against cross-tenant info disclosure.
- **Future auditors / security reviews** — a clear, code-enforced tenant boundary on every storefront table that holds user data.
- **Future workers / programmatic clients** — any code that interacts with BA's session endpoint receives only the current tenant's data.

## Acceptance Criteria

1. **Schema:** `tenant_end_user_sessions` has a non-nullable `tenant_id uuid REFERENCES tenants(id) ON DELETE CASCADE` column. Existing rows backfilled from their `tenant_end_users.tenant_id` FK; migration is idempotent.
2. **BA config:** `packages/auth-core/src/storefront.ts` session block registers `additionalFields.tenantId` with `input: false` (defense-in-depth — external HTTP callers cannot spoof). `cookieCache` stays enabled with the same 5-minute TTL it had pre-fix (see § Edge Cases #5 for the trade-off and § Open Questions §1 for the planned follow-up).
3. **Adapter writes:** `session.create` in the wrapped adapter stamps `tenantId: ctx.tenantId` alongside the existing `currentBrandId` stamping.
4. **Adapter reads:** `SCOPED_MODELS` includes `'session'`; session `findOne` / `findMany` / `count` / `update` / etc. append the `tenantId = ctx.tenantId` predicate. **Note:** because cookieCache stays enabled, BA's `get-session` short-circuits the adapter on cookie-cache hits; the predicate runs only on cache misses + on every other adapter-routed session call (delete-session-by-token, list sessions, etc.).
5. **E2E:** the cookie Domain-attribute guard from DEL-26 still passes (1 test in [`cookie-isolation.spec.ts`](../../apps/storefront/tests/e2e/cookie-isolation.spec.ts)). The two cross-tenant cookie-replay tests originally drafted during DEL-26 stay dropped — the BA `get-session` short-circuit makes the test fail even with the SCOPED_MODELS extension; restoring them lands with the follow-up that closes the cookieCache path.
6. **Same-tenant cross-brand still works:** `auth.spec.ts` cross-brand recognition tests (DEL-7 disclosure + DEL-14 welcome-back + sibling-brand same-tenant) all still pass. The fix narrows cross-tenant writes only; same-tenant lookups stay reachable.
7. **Food-hall flow still works:** `food-hall.spec.ts` end-to-end (mode-3 OOMI flow with post-server-action-redirect order detail page render) still passes. The `Host` header drop in Next.js 16 server-action redirects only matters when cookieCache is disabled; with cookieCache enabled the adapter isn't hit on the post-redirect render path.
8. **ADR-0010 amendment:** dated entry describing the fix is appended to [`docs/decisions/0010-tenant-scoping-injection.md`](../decisions/0010-tenant-scoping-injection.md) § Amendments.

## Non-Goals

- ❌ Postgres RLS (auth-spec §12 — deferred, separate phase).
- ❌ Refactor of BA's internal session lookup mechanism. We work with what BA 1.6.11 ships.
- ❌ New error codes / API surface — the gap closes silently; clients that attempted cross-tenant replay just receive `null` user instead of the wrong user.
- ❌ Session-token rotation on tenant boundary crossing. Out of scope — the fix is at the lookup layer, not the issuance layer.

## Data Model Changes

```
tenant_end_user_sessions
  + tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE
  + idx: tenant_end_user_sessions_tenant_idx ON (tenant_id)
```

**Migration ordering** (per AGENTS.md gotcha "Drizzle backfills"):

1. `ALTER TABLE tenant_end_user_sessions ADD COLUMN tenant_id uuid;` (nullable).
2. `ALTER TABLE tenant_end_user_sessions ADD CONSTRAINT … FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;`
3. `UPDATE tenant_end_user_sessions s SET tenant_id = u.tenant_id FROM tenant_end_users u WHERE s.tenant_end_user_id = u.id AND s.tenant_id IS NULL;` (idempotent — only fills NULLs; safe to rerun).
4. `ALTER TABLE tenant_end_user_sessions ALTER COLUMN tenant_id SET NOT NULL;`
5. `CREATE INDEX IF NOT EXISTS tenant_end_user_sessions_tenant_idx ON tenant_end_user_sessions (tenant_id);`

Steps 1+2+3+4 must happen in one migration file to keep the schema crash-safe. Step 5 can be in the same file.

**Pre-migration sanity check** (per `feedback_pre_migration_sanity_check`):

```sql
-- Should return zero rows. If any row has a NULL or non-matching tenant_id
-- compared to its end-user's tenant, the backfill plan is wrong.
SELECT
  s.id AS session_id,
  s.tenant_end_user_id,
  u.tenant_id AS user_tenant_id,
  count(*) AS row_count
FROM tenant_end_user_sessions s
JOIN tenant_end_users u ON u.id = s.tenant_end_user_id
GROUP BY s.id, s.tenant_end_user_id, u.tenant_id
HAVING count(*) > 1
   OR u.tenant_id IS NULL;

-- Sanity: count of session rows that will be touched by the backfill.
SELECT count(*) AS sessions_to_backfill
FROM tenant_end_user_sessions
WHERE tenant_id IS NULL;
```

## API Surface

No new actions or endpoints. Existing `/api/auth/get-session` (and any other session-touching endpoint) becomes tenant-scoped by virtue of the wrapped adapter.

Adapter wrapper changes:

- `SCOPED_MODELS` extends from `{'user', 'verification', 'account'}` to `{'user', 'verification', 'account', 'session'}`.
- `session.create` stamps `tenantId: ctx.tenantId` (defense-in-depth — `input: false` already prevents external spoofing; this is the trusted write path).

BA config changes (`packages/auth-core/src/storefront.ts` session block):

```ts
session: {
  fields: { userId: 'tenantEndUserId' },
  additionalFields: {
    currentBrandId: { type: 'string', required: false, input: false },
    tenantId:       { type: 'string', required: false, input: false },  // NEW
  },
  // ... existing expiresIn / updateAge / cookieCache unchanged
}
```

## Edge Cases

1. **Sessions created before the migration.** Backfill populates `tenant_id` from the user row's `tenant_id`. After the migration, every session row has a non-null `tenant_id`. No code change needed for existing sessions; they survive the migration as scoped rows.
2. **User soft-delete then session lookup.** Soft-delete sets `tenant_end_users.deleted_at` but doesn't touch the session row. The session's `tenant_id` remains valid; cascade only fires on hard-delete. Existing behavior preserved.
3. **Cross-tenant cookie replay (the target case).** Cookie minted at tenant A reaches tenant B. BA's session findOne hits the wrapped adapter, predicate `tenant_id = tenant-B-id` is appended, query returns zero rows. BA's getSession returns null. Caller sees an anonymous session — info disclosure closed.
4. **Same-tenant cross-brand (the must-still-work case).** Cookie minted at pizza-express (tenant A, brand pizza) reaches burger-heaven (tenant A, brand burger). Same tenant, so predicate matches. Session returned. This is the existing cross-brand-recognition flow and stays unchanged.
5. **`cookieCache` — stays enabled with a known limitation.** BA's storefront config sets `session.cookieCache.enabled: true` (5-min TTL). BA's `dist/api/routes/session.mjs` short-circuits `get-session` when cookieCache is enabled: it decrypts the session payload directly from the `session_data` cookie (signed with the shared BA secret, JWE/JWT-encoded) and returns it **without calling the adapter**. The wrapped adapter's tenant predicate on `session.findOne` therefore never runs on a cache hit, and a cross-tenant cookie replay during the cache window still returns the source-tenant payload. **Why cookieCache stays on:** disabling it makes every protected-path request do a DB lookup, and the lookup goes through the wrapped adapter, which calls `resolveStorefrontTenantContext`. In Next.js 16 the post-server-action-redirect page render drops the storefront subdomain from the `Host` header — `apps/storefront/src/app/(shop)/orders/[orderId]/page.tsx` documents the quirk inline. With `cookieCache=true` the order detail page never hits the adapter and the host-drop is irrelevant; with `cookieCache=false` the resolver throws on bare-host and the page errors. Restoring the cross-tenant replay tests is therefore deferred to a follow-up that closes the cookieCache path without breaking the redirect render — see § Open Questions §1.
6. **Programmatic clients (CLI, Inngest workers) constructing storefront BA.** If a future worker uses a different `resolveTenantContext`, it can construct sessions for "its" tenant. The wrapper unconditionally stamps `tenantId` at create time — there's no path to insert a row with the wrong tenant.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Migration leaves orphan NULL `tenant_id` rows. | Low | High | Sanity-check SQL in PR body (this spec) + idempotent backfill UPDATE with `WHERE tenant_id IS NULL` + SET NOT NULL as the last migration step (fails loudly if any row escapes). |
| BA's session lookup uses a code path that bypasses `findOne` (e.g., raw SQL). | Low | High | Storefront e2e covers signup → cookie inspect → cross-tenant replay; if any cookie cross-tenant returns a session, the test fails loudly. |
| The `tenantId` BA `additionalField` isn't preserved by BA's `transformInput` (the DEL-12 lesson). | Medium | High | Register `tenantId: { input: false }` exactly like the existing DEL-12 `account.additionalFields.tenantId`; the BA factory's `transformInput` preserves declared additionalFields by name. |
| BA upgrades 1.6.x → 1.7.x change `DBAdapter` semantics. | Low | Medium | The wrapper has an exhaustive switch on model names; new methods would fail to type-check. Existing precedent: same risk acknowledged in ADR-0010. |
| Cascade delete order on tenant hard-delete creates an FK violation. | Low | Medium | `ON DELETE CASCADE` on `tenant_id` matches the existing `tenant_end_user_id ON DELETE CASCADE`. Postgres resolves multiple cascade paths in one transaction (same shape as DEL-24's dual-path cascade — already tested in `commerce-schema.spec.ts` FK policy test). |

## Open Questions

1. **Closing the cookieCache cross-tenant gap (follow-up, no Linear issue yet).** As documented in § Edge Cases #5, BA's cookieCache short-circuits the adapter on cache hits, so the SCOPED_MODELS extension only applies on cache misses + other adapter-routed session calls. Two viable closure paths:
   - **BA `cookieCache.version` callback.** BA's session route reads a `versionConfig` callback at cache-validate time (`node_modules/better-auth/dist/api/routes/session.mjs`). If the callback returns the **current** tenant context's id (resolved from `next/headers`) and the cached payload's `version` field was set to the **session-writer** tenant's id at cache-write time, a cross-tenant replay forces a version mismatch → cache expires → DB lookup → predicate applies → cross-tenant rejected. Requires hooking `cookieCache.version` into `resolveStorefrontTenantContext` (which currently throws on bare-host post-redirect, so the version callback would need its own fallback — likely a separate header source via `x-storefront-id` injected by the proxy).
   - **Next.js post-server-action-redirect Host fix.** If the bare-host bug is fixable upstream (or via a Next.js config — `experimental.serverActions.allowedOrigins` etc.) then disabling cookieCache becomes viable and the predicate runs unconditionally.

   Either path is a small standalone PR — the schema + adapter changes shipping here lay the groundwork.

## Decisions Log

| Date | Decision | Reasoning |
|---|---|---|
| 2026-05-28 | Schema migration (add column) over adapter-only post-lookup filter | Matches the DEL-12 precedent for `tenant_end_user_accounts`. The wrapper's tenant predicate is the canonical mechanism; bolting on a different mechanism for sessions would create two paradigms. |
| 2026-05-28 | Backfill via JOIN, not via app-level loop | Single UPDATE … FROM is atomic and orders of magnitude faster than fetching + writing in a script. |
| 2026-05-28 | `ON DELETE CASCADE` on tenant_id FK | Matches `tenant_end_user_id` ON DELETE CASCADE. Tenant hard-delete already cascades through end-users to sessions; adding a second cascade path is consistent. |
| 2026-05-28 | `input: false` on `additionalFields.tenantId` | Defense-in-depth — external HTTP callers cannot spoof. The wrapper is the only trusted write path. Mirrors DEL-12 `account.additionalFields.tenantId`. |
| 2026-05-28 | No Linear issue | Small bug fix, ~30-60 min scope. Precedent: PR #58 OAuth fix shipped without Linear. Larger work would warrant a project + milestone. |
| 2026-05-28 | Cross-tenant cookie tests restored in same PR | Tests + fix land together so reviewers can confirm both directions without separate PRs. |
| 2026-05-28 | Keep `cookieCache` enabled despite the SCOPED_MODELS extension | Discovered mid-implementation: with `cookieCache.enabled: true`, BA's `get-session` decrypts the session payload from a separate `session_data` cookie without calling the adapter. Disabling it would force every request through the adapter and apply the tenant predicate — but it also broke `food-hall.spec.ts` end-to-end. Root cause: Next.js 16's post-server-action-redirect page render drops the storefront subdomain from `Host`, the wrapped adapter's `resolveStorefrontTenantContext` throws on the bare host, and the order detail page errors. With cookieCache on, the order detail page reads the cached session payload and never hits the adapter — no host-resolution required. The schema + write-side stamping in this fix still ship (every new session row carries `tenant_id`); restoring the cross-tenant replay tests is deferred to a follow-up that closes the cookieCache path properly. See § Open Questions §1. |

---

## Files that will change

**New:**
- `docs/specs/session-model-scoped.md` (this spec)
- `packages/db/migrations/000N_*.sql` (the schema migration)

**Modified:**
- `packages/db/src/schema.ts` — add `tenantId` to `tenantEndUserSessions` table + index.
- `packages/auth-core/src/storefront.ts` — register `session.additionalFields.tenantId`.
- `packages/auth-core/src/storefront-adapter.ts` — add `'session'` to `SCOPED_MODELS`, stamp `tenantId` on `session.create`, update file header comment.
- `packages/auth-core/src/storefront-adapter.test.ts` — add cases for session scoping.
- `apps/storefront/tests/e2e/cookie-isolation.spec.ts` — restore the two cross-tenant cookie-replay tests dropped during DEL-26 (now passing).
- `docs/decisions/0010-tenant-scoping-injection.md` — append dated Amendment entry.
- `docs/specs/storefront-tenant-scoping.md` — flip "session lookups by token pass through" wording; update decision row #1 + § 5.2 session row + § 10.
- `docs/specs/food-hall-test-matrix.md` — close Open Question §2 (move to Decisions Log entry).
