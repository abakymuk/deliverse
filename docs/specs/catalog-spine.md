# Minimal Catalog Spine (X3) — Spec v1

**Created:** 2026-05-29
**Status:** In Progress
**Owner:** Vlad
**Linear:** [DEL-34](https://linear.app/oveglobal/issue/DEL-34) (Phase 4 / NEXT / X3). Depends only on N3 (DEL-30, done); independent of X1/X4/X6.

---

## Problem

`cart_items.modifiers_json` and `order_intent_items.modifiers_snapshot_json` are typed `ModifierSnapshot[]` (N3) whose `modifierGroupId` / `modifierId` are **soft pointers into a catalog that doesn't exist yet**. Build the long-lived catalog domain (categories + modifiers) now — *before* any operator menu UI — so the snapshots have a real source of truth to resolve against, and the OOMI food-hall showcase has real modifiers.

## Users

- **Storefront guests** — future modifier-selection UI reads modifier_groups/modifiers (not in X3).
- **Operators** — future menu/catalog CRUD writes these tables (not in X3).
- **Cart/order resolution** — given a persisted `ModifierSnapshot`, resolve the live modifier name + `price_delta_cents` from the catalog by id.

## Acceptance Criteria

1. Migration `0012` applies cleanly and is **purely additive** (new enum + 4 tables + 2 nullable `menu_items` columns; no DROP, no data backfill). Existing `menu_items.category_id` stays NULL.
2. Seed creates a canonical catalog (1 category + a single-select "Size" group with 3 modifiers) for the hospitality-group (Pizza Express, Burger Heaven) + OOMI (oomi-burger, oomi-pizza) brands, idempotently; assigns each item to its brand's category.
3. **Read-path test** (`packages/db/src/catalog-resolution.test.ts`, DB-gated): given a snapshot's `modifierId`, resolves `name` + `price_delta_cents` from the **catalog** (not the snapshot's denormalized copy); resolves the menu_item ↔ modifier_group link + the item's category.
4. No operator menu UI / modifier-selection UI ships in X3.

## Non-Goals

- ❌ `media_assets` + `menu_items.image_id` — deferred until an image-upload consumer exists (no empty tables).
- ❌ `slug` uniqueness / backfill — `slug` is a plain nullable column; constrain it when routing/SEO consumes it.
- ❌ Storefront modifier-selection UI, add-to-cart modifier capture, cart/order modifier rendering, operator menu CRUD.
- ❌ `menu_item_availability` / `menu_item_pricing` / dietary-allergen columns / `embedding` (L5).

## Data Model Changes

```
enum modifier_selection_type: 'single' | 'multi'

categories                  id, brand_id (FK→brands CASCADE), name, sort_order, is_active,
                            created_at, updated_at, deleted_at            INDEX (brand_id)
modifier_groups             id, brand_id (FK→brands CASCADE), name, selection_type,
                            min_select, max_select (null=unlimited), …timestamps  INDEX (brand_id)
modifiers                   id, modifier_group_id (FK→modifier_groups CASCADE), name,
                            price_delta_cents (may be <0), is_default, sort_order, …  INDEX (modifier_group_id)
menu_item_modifier_groups   menu_item_id (FK→menu_items CASCADE), modifier_group_id (FK CASCADE),
                            sort_order   PK (menu_item_id, modifier_group_id)  INDEX (modifier_group_id)

menu_items  + slug (text, nullable)
            + category_id (uuid, nullable, FK→categories ON DELETE SET NULL)
```

Brand-owned (tenant-safety transitive via `brand.tenant_id`, like menus/menu_items). The `ModifierSnapshot` soft pointers reference `modifier_groups.id` / `modifiers.id` by id (no FK) — they survive catalog hard-delete.

## Edge Cases

1. **Same-brand integrity is NOT DB-enforced** (Known gap) — neither `menu_items.category_id` nor `menu_item_modifier_groups` enforces that the referenced category/group belongs to the item's brand. Consistent with the schema's existing soft transitive-safety approach; enforcement belongs to the later operator-CRUD layer. The seed assigns same-brand only.
2. **Category delete** — `menu_items.category_id` is `SET NULL`, so deleting a category leaves items uncategorized rather than deleting them.
3. **Soft pointers** — a persisted snapshot referencing a since-deleted modifier still renders from its own denormalized `name`/`priceDeltaCents`; the catalog read-path is best-effort (the modifier row may be gone).
4. **`max_select` NULL** = unlimited (multi-select groups with no upper bound).

## Decisions Log

| Date | Decision | Reasoning |
|---|---|---|
| 2026-05-29 | Defer `media_assets` + `menu_items.image_id` | No image-upload consumer; avoid an empty table (same discipline as payments→X4) |
| 2026-05-29 | `slug` nullable, no uniqueness | No routing/SEO consumer yet; add partial-unique + backfill when one lands |
| 2026-05-29 | `category_id` additive-only (existing rows NULL) | Keeps migration purely additive (no backfill); seed assigns categories for the seeded brands |
| 2026-05-29 | Seed catalog is canonical (un-gated) | hospitality + OOMI are already canonically seeded; gating would leave the prd OOMI showcase with no modifiers. All current tenants are demo/test; the AC#3 test owns its fixtures so it doesn't depend on seed state |

---

## Files that will change

- `packages/db/src/schema.ts` — enum + 4 tables + 2 `menu_items` columns + relations + type exports.
- `packages/db/migrations/0012_*.sql` + `meta/` — drizzle-generated (additive).
- `packages/db/src/seed.ts` — canonical catalog for hospitality + OOMI.
- `packages/db/src/catalog-resolution.test.ts` — new DB-gated read-path test (AC#3).
- `packages/db/src/modifier-snapshot.ts` (+ `.test.ts`) — drive-by: stale `order_line_items` → `order_intent_items` comment.
