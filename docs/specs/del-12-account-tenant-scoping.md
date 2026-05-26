# DEL-12 — Storefront `tenant_end_user_accounts` tenant scoping — Spec v1

**Created:** 2026-05-26
**Status:** Shipped
**Owner:** Vlad
**Linear:** [DEL-12](https://linear.app/oveglobal/issue/DEL-12)
**Builds on:** [DEL-3](https://linear.app/oveglobal/issue/DEL-3) + [ADR-0010](../decisions/0010-tenant-scoping-injection.md) + [`storefront-tenant-scoping.md`](./storefront-tenant-scoping.md)
**Unblocks:** [DEL-7](https://linear.app/oveglobal/issue/DEL-7) storefront Google OAuth signup

---

## Problem

DEL-3 wrapped the storefront BA Drizzle adapter so `user` + `verification` models are tenant-scoped, but the `account` model was deliberately carved out ([ADR-0010 §6](../decisions/0010-tenant-scoping-injection.md)) because `tenant_end_user_accounts(provider_id, account_id)` is **globally unique** — adapter scoping alone can't fix that. A guest signing in via Google OAuth at brand-A and again at brand-B (different tenant) would link to brand-A's user row globally. Storefront OAuth signup was therefore gated on this issue.

BA's OAuth flow (`node_modules/.pnpm/better-auth@1.6.11/.../dist/db/internal-adapter.mjs` → `dist/oauth2/link-account.mjs:9-91`) does `findOne({model: 'account', where: [{accountId}, {providerId}]})` first; if found, sessions are issued for the linked user. Without a tenant predicate, that first lookup leaks across tenants.

## Users

- **Restaurant guests** using Google OAuth across multiple brands of different tenants. Today their second-tenant sign-in incorrectly logs them in as the first-tenant user; post-DEL-12 they get a fresh per-tenant account.

## Acceptance Criteria

1. `packages/db/src/schema.ts` — `tenant_end_user_accounts` has `tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE`; the global `unique(provider_id, account_id)` is replaced with `unique(tenant_id, provider_id, account_id)`.
2. Migration `packages/db/migrations/0002_polite_ego.sql` applies cleanly to stg + prd: adds nullable column, backfills from FK user, sets NOT NULL, adds FK, creates new unique, drops old unique — in that order. Pre-migration sanity check (`SELECT COUNT(*) AS orphans FROM tenant_end_user_accounts a LEFT JOIN tenant_end_users u ON u.id = a.tenant_end_user_id WHERE u.id IS NULL OR u.tenant_id IS NULL`) returns 0 before merge.
3. `packages/auth-core/src/storefront-adapter.ts` — `SCOPED_MODELS` includes `account`; `create({model: 'account', ...})` stamps `tenantId` from the resolver; all account reads/mutations pick up the tenant predicate via the existing `SCOPED_MODELS.has(model)` dispatch.
4. `packages/auth-core/src/storefront.ts` — BA `account` config gains `additionalFields.tenantId: { type: 'string', required: false, input: false }` so the adapter factory's `transformInput` preserves the wrapper-injected field. Top JSDoc updated to reflect account scoping; `// REMAINING GAP (TODO DEL-3a)` comment removed.
5. Adapter unit tests at `packages/auth-core/src/storefront-adapter.test.ts` (colocated per current package convention) cover: account create stamping, account find/update/delete predicate injection, session-unchanged regression, user/verification regression, resolver-throws propagation.
6. ADR-0010 amended; `storefront-tenant-scoping.md` §6 + §10 + §11 updated.

## Non-Goals

- ❌ Soft-delete (`deleted_at`) on `tenant_end_user_accounts`. AC's "partial index WHERE deleted_at IS NULL" was copy-paste from sibling tables; accounts cascade-delete with their user, so soft-delete is YAGNI. Plain unique index, no `WHERE`.
- ❌ Real cross-tenant OAuth E2E test (Playwright). Needs DEL-8's multi-tenant seed + a Google OAuth test-double. Added as `test.skip` placeholder.
- ❌ Postgres RLS (auth-spec §12 — deferred).
- ❌ Cross-tenant account *linking* policy (auth-spec §7 forbids; reaffirmed).

## Approach

**Fix path: schema delta + BA config + adapter wrapper, all in one PR.** Partial commits would either silently no-op writes (BA config without wrapper) or hit BA field-validation errors (wrapper without BA config). Same-PR landing is non-negotiable.

### Schema delta

```ts
// packages/db/src/schema.ts:545
export const tenantEndUserAccounts = pgTable('tenant_end_user_accounts', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' }),
  // ... existing fields unchanged
}, (t) => ({
  tenantProviderAccountIdx: uniqueIndex('tenant_end_user_accounts_tenant_provider_account_idx')
    .on(t.tenantId, t.providerId, t.accountId),
  userIdx: index('tenant_end_user_accounts_user_idx').on(t.tenantEndUserId),
}));
```

### Migration ordering

Drizzle's default output adds `NOT NULL` immediately, which would fail on existing rows. Hand-edited to:

1. `ADD COLUMN tenant_id uuid` (nullable)
2. `UPDATE ... SET tenant_id = u.tenant_id FROM tenant_end_users u WHERE u.id = a.tenant_end_user_id` (backfill)
3. `ALTER COLUMN tenant_id SET NOT NULL`
4. `ADD CONSTRAINT ... FOREIGN KEY ("tenant_id") REFERENCES tenants(id) ON DELETE CASCADE`
5. `CREATE UNIQUE INDEX ... (tenant_id, provider_id, account_id)` — **before** drop, since the old (stricter) global unique guarantees no duplicate-key failure on the new (looser) per-tenant unique
6. `DROP INDEX tenant_end_user_accounts_provider_account_idx`

The CREATE-before-DROP order means there's never a window without uniqueness coverage, even if the migration runner ever stops wrapping all statements in a single transaction.

### BA account-model config

```ts
// packages/auth-core/src/storefront.ts:77
account: {
  fields: { userId: 'tenantEndUserId' },
  additionalFields: {
    tenantId: {
      type: 'string',
      required: false,
      input: false, // defense-in-depth: external callers can't spoof
    },
  },
},
```

Mirrors the existing `user.additionalFields.tenantId` registration. Without this, the adapter factory's `transformInput` (`@better-auth/core/dist/db/adapter/factory.mjs:99-141`) only maps known fields — wrapper-injected `data.tenantId` would be silently dropped.

### Adapter wrapper

```ts
// packages/auth-core/src/storefront-adapter.ts
const SCOPED_MODELS = new Set(['user', 'verification', 'account']);  // +'account'

// in wrapMethods(...).create():
if (model === 'account') {
  const ctx = await resolveTenantContext();
  return inner.create({
    model,
    data: { ...data, tenantId: ctx.tenantId },
    select,
    forceAllowId,
  });
}
```

All read/mutation methods (`findOne`/`findMany`/`count`/`update`/`updateMany`/`delete`/`deleteMany`/`consumeOne`) automatically get scoping via the existing `SCOPED_MODELS.has(model)` dispatch + `withTenantWhere` helper. No per-method changes.

## Edge Cases

1. **Existing rows on stg + prd** (1 each from DEL-15 smoke residue): backfilled in step 2 of the migration. Pre-migration orphan check verified 0 orphans before merge.
2. **Same Google account, two tenants** (the bug DEL-12 fixes): post-DEL-12, `findOne({accountId, providerId, tenantId: A})` returns A's row; `findOne({accountId, providerId, tenantId: B})` returns null → BA falls through to email lookup or `createOAuthUser`.
3. **Resolver fails** (no resolvable brand subdomain): adapter wrapper propagates the `APIError('BAD_REQUEST', { code: 'TENANT_CONTEXT_REQUIRED' })`. Same behavior as user/verification scoping today.
4. **Account row without a matching tenant** (data corruption): FK constraint prevents insertion; backfill UPDATE would either match or leave the row with NULL tenant_id (which then fails the SET NOT NULL step — loud, not silent).

## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| `additionalFields.tenantId` registration missing → wrapper silently no-ops | L | H | Path A.4 smoke verifies fresh signup writes the field end-to-end. Same-PR landing of BA config + wrapper. |
| Migration runner doesn't wrap statements in a transaction → window without uniqueness | L | L | CREATE new unique BEFORE drop old; old is stricter so new can't fail. |
| Adapter wrapper extension breaks user/verification scoping regression | L | H | Adapter test suite covers user + verification regressions explicitly. |
| Soft-delete pattern needed later → schema diverges from sibling tables | L | L | Separate ticket can ADD COLUMN deleted_at + recompose to partial unique without breaking changes. |

## Decisions Log

| Date | Decision | Reasoning |
|---|---|---|
| 2026-05-26 | No `deleted_at` column / no partial-index `WHERE` | YAGNI per AGENTS.md. Accounts cascade-delete with user; no soft-delete UX. AC's parenthetical was copy-paste from sibling tables. Reversible: separate ticket can add it. |
| 2026-05-26 | Amend ADR-0010 vs new ADR | ADR-0010 already forward-references DEL-3a in §6 + `## Amendments` section is established (DEL-5 amended). One ADR per architectural lineage. |
| 2026-05-26 | Adapter unit test in `src/`, not `__tests__/` | Match current package convention (one of the worktrees has `storefront-url.test.ts` colocated). Vitest discovers via default glob; no config change needed. |
| 2026-05-26 | E2E cross-tenant OAuth test `test.skip` | Needs DEL-8's multi-tenant seed + a Google OAuth test-double. Same pattern DEL-3 used for `cross-tenant.spec` (already skipped pending DEL-8). |
| 2026-05-26 | Migration CREATE new index before DROP old | Old (provider_id, account_id) global unique is stricter than new (tenant_id, provider_id, account_id) per-tenant unique. New can't fail on duplicate keys; old can't be re-created if dropped first. Continuous uniqueness coverage. |
| 2026-05-26 | Backfill UPDATE inside the same migration | Drizzle-kit default puts `NOT NULL` on ADD COLUMN immediately, which fails on existing rows. Hand-edit to insert backfill between ADD COLUMN nullable + SET NOT NULL. Per [feedback-pre-migration-sanity-check](../../memory/feedback_pre_migration_sanity_check.md). |

---

## Files that changed

**New:**
- `packages/db/migrations/0002_polite_ego.sql`
- `packages/auth-core/src/storefront-adapter.test.ts`
- `docs/specs/del-12-account-tenant-scoping.md` (this file)

**Modified:**
- `packages/db/src/schema.ts` — `tenant_end_user_accounts` field + index delta
- `packages/auth-core/src/storefront.ts` — top JSDoc + `account.additionalFields.tenantId`; dropped TODO comment
- `packages/auth-core/src/storefront-adapter.ts` — `SCOPED_MODELS` + new `account` create case
- `docs/decisions/0010-tenant-scoping-injection.md` — `## Amendments` entry
- `docs/specs/storefront-tenant-scoping.md` — §4 row #6, §5.2 account row, §10 OAuth limitation removed, §11 amendment
- `AGENTS.md` — Current Focus reflects DEL-12 done; OAuth unblocked
- `apps/storefront/tests/e2e/storefront-tenant-scoping.spec.ts` — added skipped cross-tenant OAuth test placeholder
