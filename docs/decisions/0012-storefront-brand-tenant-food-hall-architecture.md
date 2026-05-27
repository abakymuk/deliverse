# 0012 — Storefront, Brand, Tenant, and Food Hall Architecture

**Date:** 2026-05-26
**Status:** Accepted
**Deciders:** Vlad

## Context

The platform must support three customer-facing modes from one codebase:

1. **Single-brand tenant** — one restaurant, one brand, one storefront.
2. **Multi-brand tenant with separate brand storefronts** — Hospitality Group runs Pizza Express, Burger Heaven, Taco House, each on its own subdomain.
3. **Multi-brand food hall** — OOMI Kitchen runs OOMI Burger, OOMI Pizza, OOMI Bowls, OOMI Wings inside one storefront, with one unified cart and one checkout.

The current implementation handles modes 1 and 2 well — the M1 vertical was built brand-first: `{brand-slug}.deliverse.app` resolves to a single brand, every storefront Better-Auth request must carry a brand context, and `tenant_end_user_sessions.current_brand_id` is `NOT NULL`. The *identity* layer is already correctly tenant-scoped per [ADR-0003](./0003-tenant-scoped-end-users.md) (one customer account per tenant, spanning that tenant's brands), but the *application shell* hard-binds storefront ↔ brand. As a result, mode 3 is not representable end-to-end today.

This ADR sets the target architecture that generalizes all three modes from a single set of primitives. Modes 1 and 2 become degenerate cases of the multi-brand model — never special-cased.

## Decision

Adopt the following first-class boundaries:

- **Tenant** = business + customer-account boundary.
- **Storefront** = customer-facing entry point / URL / app shell (new first-class concept, not equivalent to brand).
- **Brand** = menu, visual identity, merchandising.
- **Location** = fulfillment boundary.
- **Cart / Order** = scoped to (tenant, location, customer). No `brand_id` ownership column.
- **Cart items / order line items** = brand-scoped via a `brand_id` column on each line.
- **Menus / menu items** = brand-owned; tenant-safety preserved via `brand.tenant_id`.
- **Single-brand tenant** = a degenerate case of the multi-brand model; never modeled separately.

## Storefront model (target)

A new first-class entity separates "URL / customer-facing shell" from "brand identity":

```
storefronts(
  id,
  tenant_id,
  slug                 -- subdomain
  name,
  type                 -- 'brand' | 'tenant'
  primary_brand_id,    -- nullable; required when type='brand'
  branding_json,
  created_at,
  updated_at,
  deleted_at
)
```

Rules:

- `type='brand'` storefront points to one `primary_brand_id`. Behaves like today's `{brand}.deliverse.app`.
- `type='tenant'` storefront represents a tenant-level food hall and does NOT require `primary_brand_id`. Behaves like the OOMI Kitchen entry point.
- A tenant may have any combination: one brand storefront, many brand storefronts, a tenant food-hall storefront, or both brand-level and tenant-level storefronts simultaneously (e.g., OOMI Kitchen food hall + an `oomi-burger.deliverse.app` microsite).
- A brand may have a brand storefront, but the brand is no longer the only possible customer-facing entry point.

**Status:** Target architecture. The `storefronts` table is NOT implemented by this ADR.

## Session model (target)

`tenant_end_user_sessions.current_brand_id` becomes NULLABLE.

- `current_brand_id IS NULL` → tenant-level / food-hall session (no specific brand context).
- `current_brand_id` UUID → user is currently in a specific brand context (mode 1, mode 2, or a brand subsection inside a food hall).
- Existing brand-anchored sessions continue working unchanged.

**Status:** Target architecture. The schema migration is NOT applied by this ADR.

## Auth / Better-Auth tenant resolution (target)

The storefront tenant-context resolver becomes tenant-required and brand-optional.

Target resolver signature:

```
{
  tenantId: string,
  storefrontId: string,
  storefrontType: 'brand' | 'tenant',
  brandId?: string,         // present when storefrontType='brand'
}
```

Target wrapped-adapter behavior:

- Always scope reads/mutations by `tenant_id` (unchanged from [ADR-0010](./0010-tenant-scoping-injection.md)).
- Stamp `current_brand_id` on session creates only when brand context exists.
- Stamp `brand_id` on verification creates only when brand context exists.
- Reject requests with HTTP 400 only when no tenant is resolvable. Absence of `brandId` is NOT an error.

**Status:** Target architecture. The resolver + adapter are NOT refactored by this ADR. ADR-0010 remains the current source of truth for the M1 brand-required behavior and will receive an amendment when the implementation lands.

## Commerce model (target)

The first commerce migration must adopt this shape from day one:

```
carts(
  id,
  tenant_id,
  location_id,
  tenant_end_user_id,       -- or anonymous_session_id for guest carts
  status,
  created_at,
  updated_at
  -- NO brand_id ownership column
)

cart_items(
  id,
  cart_id,
  brand_id,                 -- brand on the line item, not the cart
  menu_item_id,
  quantity,
  modifiers_json,
  unit_price_cents,
  created_at,
  updated_at
)

orders(
  id,
  tenant_id,
  location_id,
  tenant_end_user_id,
  status,
  subtotal_cents,
  tax_cents,
  fee_cents,
  tip_cents,
  total_cents,
  created_at,
  updated_at
  -- NO brand_id ownership column
)

order_line_items(
  id,
  order_id,
  brand_id,                 -- brand on the line item, not the order
  menu_item_id_snapshot,    -- snapshot for historical accuracy
  name_snapshot,
  quantity,
  modifiers_snapshot_json,
  unit_price_cents,
  total_cents
)

menus / menu_items
  -- belong to brand_id
  -- tenant-safety preserved transitively through brand.tenant_id
```

Rationale:

- Mode 1 (single brand): all `cart_items.brand_id` share one value. No data-shape change vs multi-brand.
- Mode 2 (separate brand storefronts): cart and order tagged by brand context per request; brand-scoped reporting via line items.
- Mode 3 (food hall): one cart, one order, mixed `brand_id` values across line items. Per-brand KDS / ticketing via `GROUP BY brand_id` on line items.
- Adding `brand_id` to `carts` or `orders` would either block mode 3 entirely or force a "primary brand" hack that contaminates analytics.

**Status:** Target architecture. The commerce schema is NOT created by this ADR.

## Supported modes (worked examples)

| Mode | Storefront | Session brand | Cart-item brand_id | Use case |
|---|---|---|---|---|
| 1 — Single-brand tenant | one `type='brand'` | always UUID | all same | one restaurant, one brand |
| 2 — Multi-brand separate storefronts | N × `type='brand'` | always UUID per brand-host | per-storefront brand | Pizza Express + Burger Heaven, separate subdomains |
| 3 — Food hall | one `type='tenant'` (may coexist with brand storefronts) | NULL for food-hall sessions; UUID inside brand subsection | mixed across line items | OOMI Kitchen: OOMI Burger + OOMI Pizza + OOMI Bowls + OOMI Wings, one cart, one checkout |

## Alternatives Considered

- **Option A: `brand_id` on cart/order with a food-hall-mode flag.** Rejected: contaminates analytics, special-cases tenant types, breaks the principle that single-brand is a degenerate case of multi-brand.
- **Option B: Multiple carts per customer (one per brand), reconciled at checkout.** Rejected: doesn't model unified checkout cleanly; breaks single-order semantics and per-order discounts/tips.
- **Option C: Keep storefront ≡ brand; add a virtual "food-hall brand" for OOMI Kitchen.** Rejected: poisons brand-as-merchandising-identity. A food hall is not a brand; it's a container of brands.
- **Option D (selected):** First-class `storefronts` entity; cart/order owned by tenant+location+customer; brand on line items.

## Consequences

### Positive

- Future-proof. Mode 3 becomes representable without retrofitting existing primitives.
- No single-brand tenant special-casing — same data model and code path as multi-brand.
- Tenant-level reporting (orders) plus brand-level analytics (line-item GROUP BY).
- Per-brand KDS / ticketing inside a food-hall order via GROUP BY on `order_line_items.brand_id`.
- Cleanest possible separation of routing concern (storefront) from merchandising concern (brand).
- Aligns with industry food-hall patterns (Incentivio, Owner.com, third-wave multi-concept operators).

### Negative

- Routing layer becomes explicit (storefront lookup instead of straight brand-slug extraction).
- Session brand context becomes optional — wrapped adapter must be mode-aware.
- Auth integration tests must cover brand-host AND tenant-host modes side-by-side.
- Migration of `current_brand_id` to nullable + adapter refactor is non-trivial.

### Neutral

- Single-brand tenants see no UX change.
- ADR-0003 (tenant-scoped end users) unchanged; this ADR builds on it.
- ADR-0010 (tenant-scoping injection) remains correct as the current state. This ADR sets the next-state target; ADR-0010 will receive an amendment when the brand-optional adapter lands.

## Non-goals (this ADR)

This ADR codifies the target architecture. It explicitly does NOT:

- Implement the `storefronts` table.
- Make `current_brand_id` nullable.
- Refactor the Better-Auth storefront resolver or wrapped adapter.
- Build the commerce schema.
- Auto-share customer preferences across brands without explicit consent.
- Break current `{brand}.deliverse.app` storefronts.
- Remove support for single-brand tenants.

All implementation work is captured in [`docs/planning/food-hall-architecture-linear-plan.md`](../planning/food-hall-architecture-linear-plan.md) for conversion into Linear issues.

## Acceptance criteria

- ADR present at `docs/decisions/0012-storefront-brand-tenant-food-hall-architecture.md`.
- ADR linked from `docs/decisions/README.md` index.
- AGENTS.md decision-log highlights reference ADR-0012.
- Dependent docs (architecture, auth-spec, storefront-tenant-scoping spec, del-15 baseURL spec, storefront AGENTS.md) link to this ADR as the source of truth for the target model.
- Implementation work captured in `docs/planning/food-hall-architecture-linear-plan.md`.
- No runtime / schema / auth / routing changes ship with this ADR.

## References

- [ADR-0003](./0003-tenant-scoped-end-users.md) — Tenant-scoped end users (foundational invariant carried forward).
- [ADR-0004](./0004-two-nextjs-apps.md) — Two Next.js apps (security boundary unchanged).
- [ADR-0010](./0010-tenant-scoping-injection.md) — Storefront tenant scoping via wrapped Drizzle adapter (current brand-required state; will receive amendment when brand-optional adapter lands).
- [`docs/specs/storefront-tenant-scoping.md`](../specs/storefront-tenant-scoping.md) — current adapter contract.
- [`docs/specs/del-12-account-tenant-scoping.md`](../specs/del-12-account-tenant-scoping.md) — account model tenant-scoping (compatible with target).
- [`docs/specs/del-15-storefront-baseurl.md`](../specs/del-15-storefront-baseurl.md) — current brand-coupled baseURL (will become brand-optional).
- [`docs/planning/food-hall-architecture-linear-plan.md`](../planning/food-hall-architecture-linear-plan.md) — delivery plan for the target architecture.
