# Session `current_brand_id` brand-optional (DEL-21) — Spec v1

**Created:** 2026-05-27
**Status:** Draft
**Owner:** Vlad
**Issue:** [DEL-21](https://linear.app/oveglobal/issue/DEL-21)
**ADR:** [0012 — Storefront, Brand, Tenant, and Food Hall Architecture](../decisions/0012-storefront-brand-tenant-food-hall-architecture.md)
**Planning doc:** [`docs/planning/food-hall-architecture-linear-plan.md`](../planning/food-hall-architecture-linear-plan.md) Issue 4
**Previous in chain:** [DEL-20 — Storefront-aware host resolution](./storefront-host-resolution.md)
**Prior art:** [`docs/specs/storefront-tenant-scoping.md`](./storefront-tenant-scoping.md) (DEL-3 — adapter wrapper this issue extends)

---

## Problem

ADR-0012 §"Session model (target)" requires `tenant_end_user_sessions.current_brand_id` to be optional: brand-host sessions carry a UUID, tenant-host food-hall sessions carry NULL. Today the column is `NOT NULL`, the adapter stamps `ctx.brandId` unconditionally, and `StorefrontTenantContext.brandId` is a required string — there is no representation of a "tenant-mode" session at any layer.

DEL-21 pairs the schema migration with the adapter write change in one PR. Schema-only without the adapter change would leave the adapter writing a non-null value into a now-nullable column with no signal of intent; the adapter change without the schema would refuse the NULL write at the DB layer. Together, they establish the column + write invariant.

DEL-21 is the second link in the auth-refactor chain (DEL-20 → DEL-21 → DEL-22 → DEL-23). The resolver remains brand-required (always returns `brandId`) until DEL-22 flips it, so the tenant-mode branch is **unreachable in production** until DEL-22 ships. The type change in DEL-21 makes the unreachable branch type-safe and unit-testable today.

## Users

- **DEL-22 (next)** — Better-Auth resolver becomes brand-optional, returning `brandId?` based on storefront type. The optional `StorefrontTenantContext.brandId` shape and adapter `?? null` are already in place when DEL-22 lands; DEL-22 is purely a resolver flip.
- **DEL-23 (after)** — verification-create adapter tightens its `brandId` stamp from passthrough to explicit `?? null`, paired with tenant-default email-branding fallback as one atomic verification unit.
- **Existing M1 sessions** — brand-mode sessions stamp UUID exactly as today; no behavior change, no row-level diff.

## Acceptance Criteria

Verbatim from [DEL-21](https://linear.app/oveglobal/issue/DEL-21):

1. **AC#1 (spec):** this spec is written, reviewed, and linked from DEL-21.
2. Migration changes `tenant_end_user_sessions.current_brand_id` to NULLABLE; existing sessions retain their UUID; no data loss.
3. Wrapped storefront adapter writes UUID for brand-mode sessions (where the host resolved to `storefrontType='brand'`) and NULL for tenant-mode sessions.
4. Read path: any session with NULL `current_brand_id` resolves to tenant context only (no brand).
5. Adapter unit tests cover both modes side-by-side.
6. M1 e2e tests still pass — existing brand-host sessions look identical at the row level.

## Non-Goals

- ❌ Better-Auth resolver / tenant-context shape (DEL-22).
- ❌ Verification-create adapter change (DEL-23) — `storefront-adapter.ts:121` stamps `brandId` unconditionally; DEL-23 tightens to `?? null` together with the email-branding fallback. See Intentional Deviation below.
- ❌ Email-branding fallback for tenant-mode OTPs (DEL-23).
- ❌ Food-hall UI shell (DEL-25).
- ❌ UI changes anywhere.

## Data Model Changes

```sql
ALTER TABLE tenant_end_user_sessions
  ALTER COLUMN current_brand_id DROP NOT NULL;
-- FK to brands(id) ON DELETE CASCADE unchanged.
-- No backfill: existing sessions keep their UUIDs.
```

The Drizzle declaration at [packages/db/src/schema.ts:680](../../packages/db/src/schema.ts) loses `.notNull()`:

```diff
- currentBrandId: uuid('current_brand_id').notNull().references(() => brands.id, { onDelete: 'cascade' }),
+ currentBrandId: uuid('current_brand_id').references(() => brands.id, { onDelete: 'cascade' }),
```

Drizzle-kit may re-emit the FK around the `ALTER COLUMN` (DROP CONSTRAINT … ADD CONSTRAINT …). The migration is hand-edited down to the pure `DROP NOT NULL` to avoid noisy FK churn — pattern matches [`packages/db/migrations/0005_nostalgic_black_knight.sql`](../../packages/db/migrations/0005_nostalgic_black_knight.sql) (DEL-19 backfill).

## API Surface

`StorefrontTenantContext` in [`packages/auth-core/src/storefront-adapter.ts`](../../packages/auth-core/src/storefront-adapter.ts) widens `brandId`:

```diff
 export type StorefrontTenantContext = {
   tenantId: string;
-  brandId: string;
+  brandId?: string;     // optional now; DEL-22 resolver will populate based on storefront type
   brandSlug: string;
 };
```

Session-create at line 84:

```diff
- data: { ...data, currentBrandId: ctx.brandId },
+ data: { ...data, currentBrandId: ctx.brandId ?? null },
```

Verification-create at line 121: **unchanged in DEL-21**. A terse trailing comment (`// DEL-23: tighten with ?? null + email-branding fallback`) marks the deliberate deferral so the next reader doesn't mistake it for a forgotten path.

`brandSlug` stays required in DEL-21 — DEL-22 revisits it when the resolver becomes brand-optional.

No new exports, no new files in `packages/`. No app-side change.

## UI Sketch

None. No UI in DEL-21.

## Edge Cases

1. **Existing brand-host sessions** — column remains populated with UUID; adapter stamps UUID exactly as today. No visible behavior change. AC#6.
2. **Tenant-mode session creation** — currently unreachable in production (resolver always returns `brandId`). When DEL-22 flips the resolver, sessions created on tenant hosts will have `currentBrandId: null`. Unit-tested in DEL-21.
3. **`cross-brand.ts:84` consumer** — `.where(eq(tenantEndUserSessions.currentBrandId, brandId))` filters by exact brand. NULL sessions are excluded by SQL `eq` semantics (NULL never equals a UUID). Semantically correct: a tenant-mode session has not "visited" any specific brand.
4. **BA cookieCache** — sessions cache as JSON; NULL round-trips transparently. No change.
5. **FK cascade** — `current_brand_id` FK remains `ON DELETE CASCADE`. A NULL value has no parent row to cascade from; deletion semantics unchanged for populated rows.
6. **Drizzle row type** — post-migration, `tenantEndUserSessions.currentBrandId` reads as `string | null`. No production consumer dereferences it expecting non-null (audited: only `cross-brand.ts:84` reads, via `eq` filter).

## Intentional Deviation — Verification adapter deferred to DEL-23

[`storefront-adapter.ts:121`](../../packages/auth-core/src/storefront-adapter.ts) stamps `brandId: ctx.brandId` on verification creates. The `tenant_end_user_verifications.brandId` column is already nullable; making it `?? null` would type-check and DB-accept under DEL-21's optional `ctx.brandId`. We deliberately do NOT make that change here because:

- The semantically-coherent unit of work for verification is "tenant-mode OTP works end-to-end": adapter writes NULL **and** email-branding falls back to tenant defaults. Splitting the adapter half into DEL-21 would leave a half-state where DEL-22 (resolver flip) might allow a tenant-host OTP request to succeed at the DB layer but produce a broken/unbranded email.
- DEL-23 owns the email-branding fallback (`packages/emails`) and the adapter `?? null` together. One PR, one review.
- The transient state when DEL-22 lands before DEL-23 (resolver returns `brandId: undefined`, adapter passes `undefined` for a nullable field) is theoretical — tenant-mode OTP isn't reachable end-to-end until DEL-23 anyway. The transient passthrough resolves to NULL at the DB driver layer.

The terse trailing comment at line 121 (`// DEL-23: …`) marks the boundary in code.

## AC#4 scope — DB + adapter invariant, not resolver behavior

The Linear AC reads: "any session with NULL `current_brand_id` resolves to tenant context only (no brand)." DEL-21 establishes the **DB + adapter invariant** that supports this:

- Schema permits NULL.
- Session-create stamps NULL when no brand is present.

There is no app read path that currently resolves a NULL session into brand context — the only brand-aware session consumer is [`cross-brand.ts:84`](../../apps/storefront/src/lib/cross-brand.ts), an `eq(currentBrandId, brandId)` filter that excludes NULL by SQL semantics (a tenant-mode session has not visited any specific brand). **DEL-22 owns the actual tenant-context resolver read behavior** when tenant-mode sessions become reachable end-to-end (resolver returns `brandId: undefined` for `storefrontType='tenant'`).

## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Existing brand sessions lose their UUID during migration | Very low | High | `ALTER COLUMN DROP NOT NULL` is non-destructive; no data step. Spot-check post-migration count of sessions with non-null `currentBrandId` matches pre-migration |
| TypeScript callers of `StorefrontTenantContext` break under optional `brandId` | Medium | Medium | `pnpm typecheck` is the gate. Most consumers read `ctx.brandId` at the adapter only; widening to `string \| undefined` is backwards-compatible (existing string values still flow through) |
| Drizzle-kit emits noisy FK churn around the ALTER | Medium | Low | Hand-edit migration down to pure `DROP NOT NULL`; precedent in `0005_nostalgic_black_knight.sql` |
| Future maintainer "simplifies" the explicit `?? null` to a conditional spread | Low | Medium | Unit test asserts `.toBe(null)` explicitly (catches both "key absent" and "value undefined") |
| Verification path transiently passes `undefined` after DEL-22 lands but before DEL-23 | Low | Low | Column is already nullable; the DB driver maps undefined to NULL via column omission. Tenant-mode OTP isn't reachable end-to-end until DEL-23, so the transient state is theoretical, not exercised in prd |

## Open Questions

None blocking. All deferred questions resolved in the Decisions Log below.

## Decisions Log

| Date | Decision | Reasoning |
|---|---|---|
| 2026-05-27 | Verification adapter deferred to DEL-23 (not bundled into DEL-21) | Tenant-mode OTP requires email-branding fallback in `packages/emails` — keep the adapter `?? null` together with the fallback as one atomic verification unit. Intentional Deviation, documented above |
| 2026-05-27 | `StorefrontTenantContext.brandId` widened to optional in DEL-21 (not deferred to DEL-22) | The type change is the contract boundary; widening it now makes the tenant-mode adapter branch type-safe and unit-testable. The branch is unreachable in production until DEL-22 flips the resolver — safe |
| 2026-05-27 | Migration is pure `DROP NOT NULL` — hand-edit FK churn out if drizzle-kit re-emits | Pattern matches DEL-19's hand-edited migration. FK behavior is unchanged; re-emission is noise |
| 2026-05-27 | Adapter session-create uses explicit `?? null` (not implicit undefined) | Drizzle's handling of `undefined` (column omission) vs `null` (explicit NULL) is undocumented; explicit `?? null` is unambiguous in code and in the resulting SQL |
| 2026-05-27 | Unit test asserts `.toBe(null)` explicitly | Catches both "key absent from payload" and "value is undefined" — guards against future maintainer "simplifying" `?? null` to a conditional spread |
| 2026-05-27 | AC#4 scoped to DB + adapter invariant | DEL-21 establishes the column + write contract; DEL-22 owns the actual resolver read behavior when tenant-mode sessions become reachable |
| 2026-05-27 | `brandSlug` stays required in DEL-21 | DEL-22 revisits the full resolver shape — not in scope for the column-nullability pairing |

---

## Files that will change

- `docs/specs/session-brand-optional.md` — this file.
- `packages/db/src/schema.ts` — drop `.notNull()` on `currentBrandId` (line 680).
- `packages/db/migrations/000N_<drizzle-slug>.sql` (new) — generated `ALTER COLUMN DROP NOT NULL`, hand-edited to remove any FK re-emission and add the standard header.
- `packages/db/migrations/meta/000N_snapshot.json` (auto-generated).
- `packages/db/migrations/meta/_journal.json` (auto-updated).
- `packages/auth-core/src/storefront-adapter.ts` — `StorefrontTenantContext.brandId` optional; session-create stamps `ctx.brandId ?? null`; one-line trailing comment at line 121 pointing at DEL-23.
- `packages/auth-core/src/storefront-adapter.test.ts` — add tenant-mode session-create case asserting `.toBe(null)`.

**Explicitly NOT modified:**

- `apps/storefront/src/lib/storefront-tenant-context.ts` — resolver stays brand-required (DEL-22).
- `packages/auth-core/src/storefront-adapter.ts:121` (verification-create) — DEL-23.
- `packages/emails/*` — email-branding fallback is DEL-23.
- `apps/storefront/src/lib/cross-brand.ts` — no change needed; `eq` filter excludes NULL by SQL semantics.
