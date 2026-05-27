# Commerce schema v1 (DEL-24) — Spec v1

**Created:** 2026-05-27
**Status:** Draft
**Owner:** Vlad
**Issue:** [DEL-24](https://linear.app/oveglobal/issue/DEL-24)
**ADR:** [0012 — Storefront, Brand, Tenant, and Food Hall Architecture](../decisions/0012-storefront-brand-tenant-food-hall-architecture.md)
**Planning doc:** [`docs/planning/food-hall-architecture-linear-plan.md`](../planning/food-hall-architecture-linear-plan.md) Issue 7
**Prior art:** [`docs/specs/storefronts-model.md`](./storefronts-model.md) (DEL-19 — additive schema precedent), [`docs/specs/session-brand-optional.md`](./session-brand-optional.md) (DEL-21 — FK + migration precedent), [`docs/specs/seed-data.md`](./seed-data.md) (idempotent seed pattern)

---

## Problem

[ADR-0012 §"Commerce model"](../decisions/0012-storefront-brand-tenant-food-hall-architecture.md) declares the target shape: `carts` and `orders` are scoped to `(tenant, location, customer)` with **no `brand_id`** ownership column, and `cart_items` + `order_line_items` carry `brand_id` **per line**. That shape is what makes mode 3 (food halls — one cart, mixed brands) representable as a degenerate case of multi-brand, rather than as a special-cased fork. The ADR does not implement the schema. There is no commerce code yet.

DEL-24 lands the migration contract. Strictly additive — no application code reads from these tables at the end of this issue. DEL-25 (food-hall UI), and later issues (checkout, KDS) build on top.

Locking in the shape now is cheap. Locking it in after commerce code starts using a "primary brand on cart" hack is expensive. This issue exists to land the right shape **before** the first commerce caller.

## Users

- **DEL-25 (next, blocked by this)** — food-hall storefront shell. Reads from `menus` / `menu_items` to render brand directories and menus. Inserts `carts` / `cart_items` from the add-to-cart UX. The multi-brand cart fixture seeded by this issue (under `SEED_TEST_FIXTURES=1`) gives DEL-25 a ready-made fixture to UI against.
- **Future checkout work** — reads cart, inserts `orders` + `order_line_items` with snapshots. The integration test in this issue exercises that shape (without HTTP) so the shape is provably correct before any checkout business logic exists.
- **Future KDS / ticketing work** — `GROUP BY order_line_items.brand_id` to fan out brand tickets inside a single food-hall order. The `order_status` enum already includes `'preparing' | 'ready'` so KDS work won't need a migration.
- **Reporting (later)** — brand-level revenue via `GROUP BY order_line_items.brand_id` (preserved through brand removal via `brand_name_snapshot`); tenant-level revenue via `orders.tenant_id`.

## Acceptance Criteria

Verbatim from [DEL-24](https://linear.app/oveglobal/issue/DEL-24):

1. **AC#1 (spec):** this spec is written, reviewed, and linked from DEL-24.
2. Migrations create `carts`, `cart_items`, `orders`, `order_line_items`, `menus`, `menu_items` with shape per ADR-0012 §6.
3. `carts` has NO `brand_id` column; `orders` has NO `brand_id` column.
4. `cart_items.brand_id` is NOT NULL with FK to `brands.id`; same for `order_line_items.brand_id`. — **See Intentional Deviation from AC#4 below.**
5. `menus.brand_id` FK to `brands`; tenant-safety carried via `brand.tenant_id` (no direct `tenant_id` on menus).
6. Drizzle relations + types exported from `@rp/db`.
7. Seed script updated: at least one tenant has multiple brands sharing one cart with mixed `brand_id` line items.
8. Integration test: create cart with line items from 2 brands of one tenant, check out → single `orders` row with `order_line_items` carrying mixed `brand_id` values.

## Non-Goals

- ❌ UI / checkout flow / cart UX (DEL-25 + later).
- ❌ Payment integration.
- ❌ KDS / ticketing UI.
- ❌ Menu management UI (admin path).
- ❌ Anonymous / guest carts — `carts.tenant_end_user_id` is NOT NULL in v1; nullable + `anonymous_session_id` is a v2 follow-up.
- ❌ Cart-abandonment cleanup jobs.
- ❌ Application-layer commerce logic — adapters, server actions, queries. The data shape is the deliverable.

## Data Model Changes

### Enums (added alongside existing `pgEnum` declarations near top of `schema.ts`)

```
cart_status        = 'active' | 'abandoned' | 'converted'
order_status       = 'pending' | 'confirmed' | 'preparing' | 'ready' | 'completed' | 'cancelled'
fulfillment_type   = 'pickup' | 'delivery'
```

### Tables

```
menus
  - id                  uuid PK default gen_random_uuid()
  - brand_id            uuid NOT NULL FK → brands(id) ON DELETE CASCADE
  - name                text NOT NULL
  - description         text NULLABLE
  - is_active           boolean NOT NULL default true
  - created_at          timestamptz NOT NULL default now()
  - updated_at          timestamptz NOT NULL default now()
  - deleted_at          timestamptz NULLABLE
  indexes:
    - menus_brand_idx on (brand_id)
  rationale:
    - tenant-safety transitive via brand.tenant_id (AC#5 — no direct tenant_id)

menu_items
  - id                  uuid PK default gen_random_uuid()
  - menu_id             uuid NOT NULL FK → menus(id) ON DELETE CASCADE
  - name                text NOT NULL
  - description         text NULLABLE
  - price_cents         integer NOT NULL
  - is_active           boolean NOT NULL default true
  - created_at          timestamptz NOT NULL default now()
  - updated_at          timestamptz NOT NULL default now()
  - deleted_at          timestamptz NULLABLE
  indexes:
    - menu_items_menu_idx on (menu_id)
  rationale:
    - NO direct brand_id column. Brand reached transitively via menu.
    - brandsRelations does NOT expose menuItems directly — chain is brand → menus → menu_items.

carts
  - id                  uuid PK default gen_random_uuid()
  - tenant_id           uuid NOT NULL FK → tenants(id) ON DELETE CASCADE
  - location_id         uuid NOT NULL FK → locations(id) ON DELETE CASCADE
  - tenant_end_user_id  uuid NOT NULL FK → tenant_end_users(id) ON DELETE CASCADE
  - status              cart_status NOT NULL default 'active'
  - fulfillment_type    fulfillment_type NOT NULL default 'pickup'
  - created_at          timestamptz NOT NULL default now()
  - updated_at          timestamptz NOT NULL default now()
  - deleted_at          timestamptz NULLABLE
  - NO brand_id column (AC#3)
  indexes:
    - carts_tenant_idx on (tenant_id)
    - carts_user_idx on (tenant_end_user_id)
    - carts_location_idx on (location_id)
    - carts_status_idx on (status)
  rationale:
    - tenant_end_user_id NOT NULL — anonymous carts deferred to v2.
    - No DB-level uniqueness on (user, location, status='active') in v1 — app picks latest.

cart_items
  - id                  uuid PK default gen_random_uuid()
  - cart_id             uuid NOT NULL FK → carts(id) ON DELETE CASCADE
  - brand_id            uuid NOT NULL FK → brands(id) ON DELETE CASCADE  (AC#4)
  - menu_item_id        uuid NOT NULL FK → menu_items(id) ON DELETE CASCADE
  - quantity            integer NOT NULL default 1
  - modifiers_json      jsonb NOT NULL default '{}'::jsonb
  - unit_price_cents    integer NOT NULL    -- snapshot at add-to-cart time
  - created_at          timestamptz NOT NULL default now()
  - updated_at          timestamptz NOT NULL default now()
  - NO soft-delete (cascades with cart)
  indexes:
    - cart_items_cart_idx on (cart_id)
    - cart_items_brand_idx on (brand_id)
    - cart_items_menu_item_idx on (menu_item_id)
  rationale:
    - All FKs CASCADE so tenant/brand/menu_item hard-delete chains don't break.
    - cart_items are transient — losing them on a hard-delete is acceptable.
    - unit_price_cents is a snapshot so concurrent menu_item price changes don't mutate the cart line.

orders
  - id                  uuid PK default gen_random_uuid()
  - tenant_id           uuid NOT NULL FK → tenants(id) ON DELETE CASCADE
  - location_id         uuid NOT NULL FK → locations(id) ON DELETE CASCADE
  - tenant_end_user_id  uuid NULLABLE FK → tenant_end_users(id) ON DELETE SET NULL
  - status              order_status NOT NULL default 'pending'
  - fulfillment_type    fulfillment_type NOT NULL
  - subtotal_cents      integer NOT NULL
  - tax_cents           integer NOT NULL default 0
  - fee_cents           integer NOT NULL default 0
  - tip_cents           integer NOT NULL default 0
  - total_cents         integer NOT NULL
  - created_at          timestamptz NOT NULL default now()
  - updated_at          timestamptz NOT NULL default now()
  - NO brand_id column (AC#3)
  - NO deleted_at — orders are append-only; cancel via status='cancelled'
  indexes:
    - orders_tenant_idx on (tenant_id)
    - orders_user_idx on (tenant_end_user_id)
    - orders_location_idx on (location_id)
    - orders_status_idx on (status)
    - orders_created_at_idx on (created_at)
    - orders_tenant_created_at_idx on (tenant_id, created_at DESC)   -- composite, recency queries per tenant
  rationale:
    - tenant_end_user_id SET NULL preserves order history through single-user GDPR deletion.
    - Tenant hard-delete still cascades through orders via tenant_id CASCADE (GDPR full-tenant cleanup).
    - See "Intentional Deviation" + "Edge cases" for the dual-cascade-path policy.

order_line_items
  - id                       uuid PK default gen_random_uuid()
  - order_id                 uuid NOT NULL FK → orders(id) ON DELETE CASCADE
  - brand_id                 uuid NULLABLE FK → brands(id) ON DELETE SET NULL  ← deviation from AC#4
  - brand_name_snapshot      text NOT NULL    -- preserves brand identity when brand_id is SET NULL
  - menu_item_id_snapshot    uuid NULLABLE    -- soft pointer, no .references() per ADR-0012
  - name_snapshot            text NOT NULL
  - quantity                 integer NOT NULL
  - modifiers_snapshot_json  jsonb NOT NULL default '{}'::jsonb
  - unit_price_cents         integer NOT NULL
  - total_cents              integer NOT NULL    -- denormalized: quantity × unit_price_cents
  - NO timestamps (immutable; created with order)
  - NO soft-delete
  indexes:
    - order_line_items_order_idx on (order_id)
    - order_line_items_brand_idx on (brand_id)
  rationale:
    - brand_id SET NULL preserves the line item if a single brand is hard-deleted (sub-tenant admin op).
    - brand_name_snapshot + name_snapshot carry forward enough identity for historical reporting.
    - menu_item_id_snapshot is a true snapshot — no FK, no integrity check, survives menu_item hard-delete.
    - Tenant cascade still wipes line items via orders.tenant_id CASCADE → order_line_items.order_id CASCADE.
```

### FK actions summary

| Source | Target | Action | Why |
|---|---|---|---|
| `menus.brand_id` | `brands.id` | CASCADE | Menu is brand-owned. |
| `menu_items.menu_id` | `menus.id` | CASCADE | Items belong to menu. |
| `carts.tenant_id` | `tenants.id` | CASCADE | Tenant boundary. |
| `carts.location_id` | `locations.id` | CASCADE | Tenant-scoped child. |
| `carts.tenant_end_user_id` | `tenant_end_users.id` | CASCADE | Transient cart dies with user. |
| `cart_items.cart_id` | `carts.id` | CASCADE | Items belong to cart. |
| `cart_items.brand_id` | `brands.id` | CASCADE | Transient — must not block tenant/brand cascade. |
| `cart_items.menu_item_id` | `menu_items.id` | CASCADE | Transient — must not block tenant/brand/menu cascade. |
| `orders.tenant_id` | `tenants.id` | CASCADE | Tenant boundary (GDPR full-tenant cleanup). |
| `orders.location_id` | `locations.id` | CASCADE | Tenant-scoped child. |
| `orders.tenant_end_user_id` | `tenant_end_users.id` | **SET NULL** | Preserve order history through single-user GDPR delete. |
| `order_line_items.order_id` | `orders.id` | CASCADE | Line items belong to order. |
| `order_line_items.brand_id` | `brands.id` | **SET NULL** | Preserve line-item history through single-brand removal. AC#4 deviation. |

### Drizzle relations (inline in `schema.ts`)

- `menusRelations`: `one(brand)`, `many(menuItems)`
- `menuItemsRelations`: `one(menu)` **only** — no direct brand
- `cartsRelations`: `one(tenant), one(location), one(tenantEndUser), many(cartItems)`
- `cartItemsRelations`: `one(cart), one(brand), one(menuItem)`
- `ordersRelations`: `one(tenant), one(location), one(tenantEndUser), many(orderLineItems)`
- `orderLineItemsRelations`: `one(order), one(brand)` — `brand` relation typed nullable
- Extend `brandsRelations`: `+ menus, cartItems, orderLineItems`. **No direct `menuItems`** — chain is brand → menus → menu_items.
- Extend `tenantsRelations`: `+ carts, orders`
- Extend `locationsRelations`: `+ carts, orders`
- Extend `tenantEndUsersRelations`: `+ carts, orders`

### Type exports

`Menu / NewMenu`, `MenuItem / NewMenuItem`, `Cart / NewCart`, `CartItem / NewCartItem`, `Order / NewOrder`, `OrderLineItem / NewOrderLineItem` — added next to each table block. `packages/db/src/index.ts` already does `export * from './schema'`.

## API Surface

None in DEL-24. No server actions, no endpoints, no app-side reads. Drizzle types are exported for downstream consumers (DEL-25 onward).

## UI Sketch

None.

## Edge Cases

1. **menu_item soft-deleted while a cart_item references it** — soft delete leaves the FK target intact; cart still reads. Normal lifecycle.
2. **menu_item hard-deleted (rare; only via tenant cascade)** — `cart_items.menu_item_id CASCADE` removes the cart_item with it. Acceptable for transient data.
3. **Brand hard-deleted (rare; only via tenant cascade or admin path)** — `cart_items.brand_id CASCADE` removes the cart_item. `order_line_items.brand_id SET NULL` preserves the line item with `brand_name_snapshot` carrying the brand identity forward.
4. **End-user hard-deleted (GDPR single-user right-to-be-forgotten)** — `carts.tenant_end_user_id CASCADE` removes the cart. `orders.tenant_end_user_id SET NULL` preserves the order (now "anonymous historical").
5. **Tenant hard-deleted (GDPR full-tenant)** — full cascade through `tenants → brands → menus → menu_items`, `tenants → tenant_end_users → carts → cart_items`, `tenants → orders → order_line_items`. No history survives. By design.
6. **Dual cascade paths from tenant to orders** — `tenants → orders.tenant_id CASCADE` AND `tenants → tenant_end_users → orders.tenant_end_user_id SET NULL`. Postgres permits multiple paths but mixed actions can produce surprising ordering. Test 2 in `commerce-schema.spec.ts` exercises this end-to-end against the real dev DB and asserts no rows survive + no FK errors.
7. **Cart abandonment** — no v1 cleanup job; status flips to `'abandoned'` manually for now. v2 follow-up.
8. **Migration re-run (drizzle journal hiccup)** — DDL is one-shot via `__drizzle_migrations` tracking. No data steps in this migration, so no manual re-run risk.
9. **`menu_item_id_snapshot` orphan** — UUID stays after menu_item hard-delete (no FK); becomes an orphan ID. Acceptable since hard-delete is rare and the snapshot is just for traceability. v2 audit task can detect.
10. **Snapshot drift between cart_items.unit_price_cents and menu_items.price_cents** — by design. Cart locks in the price the customer saw at add-to-cart; later menu_item price edits do not retroactively change the cart line.

## Intentional Deviation from Linear AC#2 — one migration, not 2-3

AC#2 body hints "(new — likely 2-3 migrations split by concern)". Spec ships **one migration** because:

- Repo precedent is one migration per Linear issue (DEL-19 = `0005_nostalgic_black_knight.sql`, DEL-21 = `0006_nostalgic_shen.sql`).
- Drizzle-kit emits one clean file from the schema diff; splitting would require multiple successive `pnpm generate` cycles with hand-shaped `schema.ts` checkpoints — more risk than value.
- The repo is forward-fix-only — we do not revert migrations. Split-for-revertability has no value.
- The 6 commerce tables are introduced together as a coherent unit; conceptually they are one architectural step.

Deviation documented here so PR review doesn't re-litigate it.

## Intentional Deviation from Linear AC#4 — `order_line_items.brand_id` NULLABLE + `SET NULL` + snapshot

AC#4 reads: "`cart_items.brand_id` is NOT NULL with FK to `brands.id`; same for `order_line_items.brand_id`."

Spec ships:

- **`cart_items.brand_id`** — NOT NULL FK to `brands.id` ON DELETE CASCADE. ✅ matches AC#4.
- **`order_line_items.brand_id`** — **NULLABLE** FK to `brands.id` ON DELETE **SET NULL**, plus new `brand_name_snapshot text NOT NULL`. ⚠ deviates.

Rationale:

- Order line items are historical records. Cart items are transient.
- If `order_line_items.brand_id` is NOT NULL CASCADE: hard-deleting a single brand silently wipes its historical line items — loses brand-attributable revenue from reporting.
- If `order_line_items.brand_id` is NOT NULL RESTRICT / NO ACTION: blocks the tenant cascade chain when a tenant is hard-deleted (GDPR full-tenant), because line items still reference brand rows that are being deleted.
- NULLABLE + SET NULL + `brand_name_snapshot` preserves the line item with brand identity carried forward in text when a single brand is removed standalone. Tenant cascade still wipes line items via `orders.tenant_id CASCADE → order_line_items.order_id CASCADE`.

The deviation is paired with the dual-cascade-path validation test (Test 2 in `commerce-schema.spec.ts`) so the design holds up against the canonical "tenant got hard-deleted" scenario. Audit trail: this section + the implementation note comment on DEL-24 + the implementation plan iteration where the deviation was reviewed.

## Intentional Deviation — extra columns beyond AC#2 strict list

- `is_active` on `menus` and `menu_items` — mirrors `brands.is_active`, lets the menu-management UI toggle visibility without soft-deleting.
- `fulfillment_type` enum on `carts` and `orders` — orthogonal to `order_status` per design direction; avoids tangling kitchen lifecycle with pickup/delivery logistics.
- `description` (nullable text) on `menus` and `menu_items` — UX necessity for menu rendering.
- `unit_price_cents` on `cart_items` — snapshot at add-time prevents price drift during shopping.
- `total_cents` on `order_line_items` — denormalized (`quantity × unit_price_cents`), simplifies reporting queries.
- `brand_name_snapshot` on `order_line_items` — required by the AC#4 deviation.

ADR-0012 §6's column list is illustrative, not exhaustive. These additions are documented to keep the diff reviewable.

## AC#7 scope — seed fixture is the multi-brand cart, not an order

AC#7 says "Seed script updated: at least one tenant has multiple brands sharing one cart with mixed `brand_id` line items." The fixture lives under `SEED_TEST_FIXTURES=1` (not the canonical seed — keeps stg/prd seed minimal). The fixture is a cart + 2 cart_items (mixed brand_id); **no test order is seeded**. The order materialization is exercised by the integration test, not by the seed.

## AC#8 scope — shape test + FK policy test, no checkout business logic

The integration test at `apps/storefront/tests/e2e/commerce-schema.spec.ts` is two test cases:

1. **AC#8 mixed-brand shape** — directly inserts a cart with 2 mixed-brand cart_items, then an order with 2 mixed-brand order_line_items + snapshots. Asserts on the rows the test writes. Does **not** assert any cart→order FK linkage (no such column in the schema).
2. **FK policy throwaway-tenant cascade validation** — creates a complete throwaway tenant (brand, location, menu, menu_item, end_user, cart, cart_item, order, order_line_item), DELETEs the tenant, asserts every child row is gone. Protects the dual-cascade-path policy on `orders.tenant_end_user_id SET NULL` + `orders.tenant_id CASCADE`.

There is no "checkout" function in this issue. The test exercises raw inserts to validate shape and FK behavior.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Drizzle-kit emits FK churn on existing tables | Low | Low | Inspect generated SQL; strip noise. Precedent: DEL-21 `0006_nostalgic_shen.sql` |
| Seed not idempotent on re-run after adding new tables | Medium | Low | Deterministic UUIDs + `onConflictDoNothing({ target: <pk> })`; verify by running `pnpm db:seed` twice |
| Test end-user partial-unique conflict misfires | Low | Low | Bare `.onConflictDoNothing()` (no target) per `seed.ts:60` `platformUsers` precedent. Read back with `isNull(deletedAt)` |
| `auth.spec.ts:33` rate-limit flake during e2e run | Medium | Low | Pre-existing; not a DEL-24 regression. Retry after 60s; document in PR Test plan |
| `vi.mock('@rp/db')` shape in `auth-core` tests | Low | Low | Mock is no-op `{ db: {}, tenantOtpLockouts: {} }`; we add no required reads in auth-core. Extend mock only if a test fails at module load |
| Reviewer pushes back on AC#4 nullable-brand deviation | Medium | Medium | This § documents the trade-off. PR Risks table also calls it out. Linear comment + plan iteration provide audit trail |
| Postgres dual-cascade-path ambiguity from `orders.tenant_end_user_id SET NULL` + `orders.tenant_id CASCADE` | Low | High | Test 2 in `commerce-schema.spec.ts` exercises "tenant got hard-deleted" end-to-end against real dev DB; asserts no rows survive + no FK errors |
| `apps/platform/next-env.d.ts` shows up modified after dev run | High | Negligible | Never commit. `git restore apps/platform/next-env.d.ts` pre-flight |
| Worktree node_modules missing | Medium | Low | `pnpm install --prefer-offline` if turbo/pnpm reports missing binaries |

## Open Questions

1. **Cart uniqueness** — DB-level UNIQUE PARTIAL on `(tenant_end_user_id, location_id) WHERE status='active' AND deleted_at IS NULL`? v1 leaves to app logic; defer to v2 once commerce UI exists.
2. **`modifiers_json` shape** — untyped jsonb in v1. v2 pins shape (e.g., `Array<{ id, name, priceDelta }>`).
3. **`anonymous_session_id` for guest carts** — deferred. v2 if UX requires browse-without-login.
4. **CHECK constraints for `quantity > 0` and positive `*_cents`** — deferred to v2. App-layer validation in v1.
5. **Brand-only admin hard-delete path** — currently brands are soft-deleted. The `SET NULL` + snapshot design on `order_line_items` makes a future admin hard-delete safe; admin UX itself is out of scope here.

## Decisions Log

| Date | Decision | Reasoning |
|---|---|---|
| 2026-05-27 | Anonymous carts deferred — `carts.tenant_end_user_id` NOT NULL in v1 | Simpler v1. v2 follow-up with nullable + `anonymous_session_id` + CHECK if UX needs browse-without-login. M3 demo accepts sign-in-first. |
| 2026-05-27 | `order_status` includes KDS states up front | Avoids a migration when KDS work begins. `preparing`/`ready` unread at PR time — documented. |
| 2026-05-27 | `fulfillment_type` enum separate from `order_status` | Order status = kitchen lifecycle. Fulfillment = pickup vs delivery. Orthogonal — future `delivery_status` won't tangle with kitchen. |
| 2026-05-27 | `fulfillment_type` on both `carts` and `orders` | Decided at cart creation (UX picks before adding items); carried into order. Avoids a join when computing delivery-vs-pickup totals from a cart view. |
| 2026-05-27 | `cart_items.unit_price_cents` is a snapshot at add-time | Prevents price drift mid-shopping. Mirrors ADR-0012's snapshot pattern. |
| 2026-05-27 | `order_line_items.menu_item_id_snapshot` has NO `.references()` | True snapshot — survives menu_item hard-delete. Trade-off: no FK integrity; orphan IDs possible. ADR-0012 implies this. |
| 2026-05-27 | No soft-delete on `orders` / `order_line_items` | Append-only. Cancel via `status='cancelled'`. |
| 2026-05-27 | One migration, not 2-3 | Repo precedent (DEL-19, DEL-21). Drizzle-kit one-shot. Forward-fix-only repo. Documented as Intentional Deviation. |
| 2026-05-27 | No DB-level cart uniqueness in v1 | App picks most-recent active cart per (user, location). v2. |
| 2026-05-27 | `menu_items` has NO direct `brand_id` column | Brand reached transitively (menu_item → menu → brand). AC#5 says menus belong to brand; AC doesn't require a direct brand_id on items. Avoids two-source-of-truth. `brandsRelations` does NOT expose `menuItems` directly. |
| 2026-05-27 | `cart_items.menu_item_id` is `ON DELETE CASCADE` (not RESTRICT) | RESTRICT / NO ACTION would block the tenant → brand → menu → menu_item hard-delete cascade chain if any live cart references the menu_item. Cart items are transient; losing them on hard-delete is acceptable. |
| 2026-05-27 | `orders.tenant_end_user_id` is NULLABLE + `ON DELETE SET NULL` | Preserves order history through single-user GDPR deletion. Tenant hard-delete still cascades via `tenant_id CASCADE`. |
| 2026-05-27 | `order_line_items.brand_id` is NULLABLE + `ON DELETE SET NULL` + `brand_name_snapshot text NOT NULL` | **Intentional deviation from AC#4 NOT NULL**. Preserves audit history through single-brand removal. Brand identity carried forward in snapshot. Cart items stay NOT NULL (transient). |
| 2026-05-27 | `orders_tenant_created_at_idx` composite index on `(tenant_id, created_at DESC)` | Tenant-scoped order history queries by recency. Cheap, useful. |
| 2026-05-27 | Quantity / `*_cents > 0` CHECK constraints deferred to v2 | Keeps migration simple. App-layer validation in v1. |
| 2026-05-27 | Seed snapshots are insert-only (no `onConflictDoUpdate`) | Re-running seed after editing canonical prices does NOT rotate `priceCents`. v2 pattern follows `platformAccounts:83-97` if rotation becomes a need. |
| 2026-05-27 | Integration test lives in `apps/storefront/tests/e2e/` (Playwright runner, no HTTP) | Matches `storefront-tenant-scoping.spec.ts` precedent: `test.describe.serial` + beforeAll fixtures + afterAll cascade cleanup + direct `@rp/db` queries. No new test runner needed. |
| 2026-05-27 | AC#8 test does NOT assert a cart→order FK link | No such column in the schema (per ADR-0012). Test asserts on rows the test wrote, not on a fictional linkage. |
| 2026-05-27 | Second test case (FK policy throwaway-tenant cascade) added | Protects the dual-cascade-path design (`orders.tenant_end_user_id SET NULL` + `orders.tenant_id CASCADE`). Postgres permits multiple paths; mixed actions can produce surprising ordering. Test asserts the net result is "everything gone, no FK error". |

---

## Files that will change

- `docs/specs/commerce-schema-v1.md` — this file (AC#1).
- `packages/db/src/schema.ts` — `+3` enums (`cartStatusEnum`, `orderStatusEnum`, `fulfillmentTypeEnum`), `+6` table blocks (menus, menuItems, carts, cartItems, orders, orderLineItems), `+6` relation exports, `+12` type exports. Extend `brandsRelations` / `tenantsRelations` / `locationsRelations` / `tenantEndUsersRelations`.
- `packages/db/migrations/000N_<drizzle-slug>.sql` (new) — drizzle-kit output, hand-edited with the standard DEL-24 header comment. No data steps. Final `N` and slug assigned by drizzle-kit at generate-time.
- `packages/db/migrations/meta/000N_snapshot.json` (auto-generated).
- `packages/db/migrations/meta/_journal.json` (auto-updated).
- `packages/db/src/seed.ts` — update file-level docstring to mention menus/menu_items; canonical block: insert menus + menu_items for both seeded brands with deterministic UUIDs (insert-only via `onConflictDoNothing`); `SEED_TEST_FIXTURES` block: extend with test end-user (bare `.onConflictDoNothing()` matching `platformUsers` precedent at `seed.ts:60`) + multi-brand cart fixture with deterministic cart and cart_item UUIDs.
- `apps/storefront/tests/e2e/commerce-schema.spec.ts` (new) — AC#8 mixed-brand cart→order integration test plus FK cascade-policy validation. Two test cases under one `test.describe.serial`.

**Explicitly NOT modified:**

- `docs/decisions/0012-storefront-brand-tenant-food-hall-architecture.md` — no amendment. DEL-24 implements ADR-0012's already-specified shape; the additional history-preservation columns (`brand_name_snapshot`, FK actions) are spec-level decisions, not ADR-level.
- `docs/decisions/README.md` — no new ADR.
- `AGENTS.md` — no conventions change.
- `packages/db/src/index.ts` — already does `export * from './schema'`.
- `apps/storefront/src/...` and `apps/platform/src/...` — no application code reads from new tables at end of issue. DEL-25 picks this up.
- `docs/architecture.md` / `docs/auth-spec.md` — get the "target architecture" wording flip in DEL-27, not here.
