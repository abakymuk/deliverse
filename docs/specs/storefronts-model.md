# storefronts table (DEL-19) — Spec v1

**Created:** 2026-05-27
**Status:** Draft
**Owner:** Vlad
**Issue:** [DEL-19](https://linear.app/oveglobal/issue/DEL-19)
**ADR:** [0012 — Storefront, Brand, Tenant, and Food Hall Architecture](../decisions/0012-storefront-brand-tenant-food-hall-architecture.md)
**Planning doc:** [`docs/planning/food-hall-architecture-linear-plan.md`](../planning/food-hall-architecture-linear-plan.md) Issue 2

---

## Problem

[ADR-0012](../decisions/0012-storefront-brand-tenant-food-hall-architecture.md) declares storefront as a first-class entity separate from brand (a URL/shell that may host one or many brands), but doesn't define the concrete migration shape. Today `brands.slug` doubles as the brand identifier AND the storefront subdomain — the routing/auth/UI layers all assume one brand per request. DEL-19 lands the schema for the new model so subsequent issues (DEL-20+) can switch routing/auth onto it without breaking existing behavior.

This spec is the migration contract for that schema. It is **strictly additive** — no routing, auth, or UI change ships with the migration. After it lands, the new `storefronts` table holds a 1:1 row for every live brand (`type='brand'`, `primary_brand_id=brand.id`), populated by backfill; the application code continues to read from `brands` unchanged.

## Users

- **Future routing layer (DEL-20)** — will resolve host → storefront via `slug` lookup instead of brand-slug lookup, then use `primary_brand_id` or `type='tenant'` semantics.
- **Phase 2 admin UI (later issue)** — will offer "create a food-hall storefront" using `type='tenant'`.
- **Tenant operators (downstream)** — get a first-class storefront concept they can name, brand, and toggle independently of the underlying brands.

## Acceptance Criteria

Verbatim from [DEL-19](https://linear.app/oveglobal/issue/DEL-19):

1. **AC#1 (spec):** this spec is written, reviewed, and linked from DEL-19.
2. Migration adds `storefronts(id, tenant_id, slug UNIQUE, name, type, primary_brand_id, branding_json, created_at, updated_at, deleted_at)` with FKs and indexes per ADR-0012 §"Storefront model (target)".
3. `type` is an enum: `'brand' | 'tenant'`. `primary_brand_id` is required when `type='brand'`, null when `type='tenant'` (enforced via DB-level CHECK constraint).
4. Backfill creates one row of `type='brand'` per existing **live** brand (`deleted_at IS NULL AND is_active = true`), with `primary_brand_id` set and `slug` matching the current brand slug.
5. Routing layer untouched — `apps/storefront/src/proxy.ts` and `extractBrandSlug` are unchanged (DEL-20 swaps them).
6. Drizzle relations + types exported from `@rp/db`.
7. Seed script creates one storefront row per seeded brand (both canonical brands + the `SEED_TEST_FIXTURES` `other-brand-test` brand).
8. Existing e2e + integration tests pass unchanged.

## Non-Goals

- ❌ Routing/proxy changes — deferred to DEL-20.
- ❌ Better-Auth resolver changes — deferred to DEL-22.
- ❌ Tenant-host (type='tenant') UX or population — deferred to DEL-25.
- ❌ Admin UI for storefronts — separate phase.
- ❌ Backfilling soft-deleted or inactive brands.

## Data Model Changes

```
new enum: storefront_type = 'brand' | 'tenant'

new table: storefronts
  - id                  uuid PK default gen_random_uuid()
  - tenant_id           uuid NOT NULL FK → tenants(id) ON DELETE CASCADE
  - slug                text NOT NULL — subdomain
  - name                text NOT NULL
  - type                storefront_type NOT NULL
  - primary_brand_id    uuid NULLABLE FK → brands(id) ON DELETE CASCADE
                        — required when type='brand', NULL when type='tenant'
                        — enforced via CHECK constraint
  - branding_json       jsonb NOT NULL default '{}'
  - is_active           boolean NOT NULL default true
  - created_at          timestamptz NOT NULL default now()
  - updated_at          timestamptz NOT NULL default now()
  - deleted_at          timestamptz NULLABLE

indexes:
  - storefronts_slug_idx          UNIQUE on (slug) WHERE deleted_at IS NULL
  - storefronts_tenant_idx        on (tenant_id)
  - storefronts_primary_brand_idx on (primary_brand_id)

constraints:
  - storefronts_type_primary_brand_check
    CHECK ((type = 'brand'  AND primary_brand_id IS NOT NULL)
        OR (type = 'tenant' AND primary_brand_id IS NULL))

drizzle:
  - storefrontsRelations (storefront → tenant, storefront → primaryBrand)
  - tenantsRelations.storefronts: many(storefronts)
  - brandsRelations.storefronts:  many(storefronts)
  - Storefront / NewStorefront type exports

backfill (in same migration):
  INSERT INTO storefronts(...)
  SELECT tenant_id, slug, name, 'brand', id, branding_json, is_active, created_at, now()
  FROM brands
  WHERE deleted_at IS NULL AND is_active = true
    AND NOT EXISTS (SELECT 1 FROM storefronts s
                    WHERE s.primary_brand_id = brands.id AND s.deleted_at IS NULL)
```

## API Surface

None in DEL-19. The Drizzle types and relations are exported from `@rp/db` for downstream consumers (DEL-20+ proxy/resolver, future admin UI), but DEL-19 ships no server actions or endpoints. The storefronts table is unread by application code at the end of this issue.

## UI Sketch

None. No UI in DEL-19.

## Edge Cases

1. **Brand soft-deleted before migration** → skipped by backfill (`deleted_at IS NULL`). If later restored via admin path, the restore handler is responsible for creating the storefront row.
2. **Brand with `is_active = false`** → skipped by backfill. Storefront resolvers today treat "live" as `deleted_at IS NULL AND is_active = true`; backfilling inactive brands would produce storefront rows that don't correspond to anything serveable. Inactive brands get a storefront row when they're flipped back to active by an admin path (later issue).
3. **Slug collision with future tenant storefront** — prevented by `storefronts_slug_idx` partial-unique. A tenant storefront cannot reuse a brand storefront's slug while the brand storefront is alive. Naming policy (e.g., reserve `food-hall-*` for tenant storefronts) is a follow-up.
4. **Migration re-run (drizzle journal hiccup)** — DDL is one-shot (drizzle's `__drizzle_migrations` table prevents re-application), but the backfill INSERT itself is guarded by `NOT EXISTS` so it's safe to rerun in isolation.
5. **Concurrent brand inserts during migration** — extremely unlikely (migrations are serialized via drizzle's runner); if it happened, the new brand simply wouldn't appear in the backfill and would need a follow-up insert or a manual flip-then-flop to trigger the admin path.

## Intentional Deviation from Linear AC#2

The column list in [DEL-19](https://linear.app/oveglobal/issue/DEL-19) AC#2 doesn't mention `is_active`. The spec adds it because:

- It mirrors `brands.is_active`, letting DEL-20's resolver filter live storefronts the same way it filters live brands.
- A later admin UI will need a "disable storefront" toggle without soft-deleting.
- Mirroring the brand convention keeps the schema regular.

The spec is canonical when it disagrees with Linear AC body — the issue tracking is a sketch; this spec is the contract.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Drizzle's `check()` doesn't generate to the expected SQL | Low | Low | Inspect the generated migration; write the CHECK as raw SQL if needed. DB enforces regardless. |
| Backfill race with concurrent brand inserts | Very low | Low | Migrations run inside drizzle's serialized runner. `NOT EXISTS` guard handles re-run. |
| Slug collision with future tenant storefront | Low | Medium | Partial-unique index prevents. Naming policy is a follow-up. |
| `branding_json` semantic drift between brand and storefront | Medium | Low | v1 copies once at backfill/seed time. No sync attempted until a future admin path defines ownership of the field. |
| Existing test regression | Low | Low | DEL-19 AC#8: run full storefront + platform e2e + unit suites before opening PR. |

## Open Questions

None at v1. If something surfaces during implementation (e.g., Drizzle's `check()` not emitting the constraint cleanly), capture inline in the migration SQL and use the raw-SQL fallback.

## Decisions Log

| Date | Decision | Reasoning |
|---|---|---|
| 2026-05-27 | Type as Postgres enum, not text + check | Matches `tenantStatusEnum` precedent at `packages/db/src/schema.ts:57`. Adding a third value later (e.g., `'kiosk'`) is one migration; not enough cost to justify text. |
| 2026-05-27 | Backfill skips inactive brands (`is_active = false`) | Resolvers treat inactive brands as "not live". Creating a storefront row for one would be misleading. Inactive brands get their storefront when reactivated. |
| 2026-05-27 | Backfill uses `WHERE NOT EXISTS`, not `WHERE NOT IN` | Cleaner index utilization; same idempotency. |
| 2026-05-27 | `is_active` added despite absent from Linear AC | Mirrors brand semantics; needed for DEL-20+ and future admin UI. |
| 2026-05-27 | `branding_json` copied once at backfill; independent thereafter | ADR-0012 says branding ultimately lives on storefront. No sync mechanism in v1 — defer to admin path. |
| 2026-05-27 | No reverse FK on `brands.primary_storefront_id` | A brand can have many storefront rows over its lifetime. Relation is `storefront → brand` (one); reverse is `brand → many storefronts`. |
| 2026-05-27 | `storefronts_primary_brand_idx` index added | Cheap, supports DEL-20+ "find storefront for brand" queries during routing transition. |
| 2026-05-27 | Migration is **strictly additive** — routing/auth/UI untouched | Plan §9 (scope discipline): if a review comment suggests pulling DEL-20+ work forward, push back. |

---

## Files that will change

- `packages/db/src/schema.ts` — `+1` enum, `+1` table block, `+1` relations export, `+2` type exports, extend `tenantsRelations` and `brandsRelations`. Add `check` to the `drizzle-orm/pg-core` import.
- `packages/db/migrations/000N_<drizzle-slug>.sql` (new) — generated DDL + manually-added backfill INSERT.
- `packages/db/migrations/meta/000N_snapshot.json` (auto-generated)
- `packages/db/migrations/meta/_journal.json` (auto-updated)
- `packages/db/src/seed.ts` — add `storefronts` import, insert canonical storefronts after brands insert, add read-back-then-insert for `other-brand-test` storefront in `SEED_TEST_FIXTURES`, update console.info lines.
- `docs/specs/storefronts-model.md` — this file.
