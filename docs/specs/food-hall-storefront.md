# Food-hall storefront shell (DEL-25) — Spec v1

**Created:** 2026-05-27
**Status:** Draft
**Owner:** Vlad
**Issue:** [DEL-25](https://linear.app/oveglobal/issue/DEL-25)
**ADR:** [0012 — Storefront, Brand, Tenant, and Food Hall Architecture](../decisions/0012-storefront-brand-tenant-food-hall-architecture.md)
**Planning doc:** [`docs/planning/food-hall-architecture-linear-plan.md`](../planning/food-hall-architecture-linear-plan.md) Issue 8
**Prior art:** [`docs/specs/storefronts-model.md`](./storefronts-model.md) (DEL-19 — storefronts table), [`docs/specs/storefront-host-resolution.md`](./storefront-host-resolution.md) (DEL-20 — proxy + resolver), [`docs/specs/session-brand-optional.md`](./session-brand-optional.md) (DEL-21 — nullable session brand), [`docs/specs/ba-brand-optional.md`](./ba-brand-optional.md) (DEL-22 — brand-optional BA), [`docs/specs/commerce-schema-v1.md`](./commerce-schema-v1.md) (DEL-24 — commerce tables)

---

## Problem

[ADR-0012](../decisions/0012-storefront-brand-tenant-food-hall-architecture.md) §"Supported modes" mode 3 describes a tenant-level storefront that hosts multiple brands inside one customer-facing shell, with a unified cart that spans brands and a checkout that produces one order carrying mixed-brand line items. The architectural prep is complete:

- `storefronts` table with `type='brand' | 'tenant'` discriminator (DEL-19).
- Proxy + resolver dispatch on storefront type (DEL-20).
- `tenant_end_user_sessions.current_brand_id` nullable for food-hall sessions (DEL-21).
- Better-Auth tenant context brand-optional (DEL-22).
- Commerce schema with `brand_id` on line items, not on cart/order (DEL-24).

What's missing: the user-visible mode-3 implementation. Tenant-host requests today render a stub (`FoodHallStub`) — "Food hall — coming soon." DEL-25 ships the directory, brand-subsection routing, unified cart, checkout, and the demo tenant seed that proves mode 3 end-to-end.

## Users

- **Food-hall customers** — browse OOMI Kitchen at `oomi-kitchen-test.deliverse.app`, see OOMI Burger + OOMI Pizza in a directory, click into a brand, add items, mix brands in one cart, check out.
- **Existing brand-storefront customers** — mode 1/2 (`pizza-express.deliverse.app`, `burger-heaven.deliverse.app`) get cart UI as well; the brand home page evolves from a placeholder to render the brand's menu using the same components as mode 3 brand subsections.
- **Future KDS / ticketing work** — relies on `order_line_items.brand_id` being populated correctly across both modes (mode-1 single-brand orders + mode-3 mixed-brand orders).

## Acceptance Criteria

Verbatim from [DEL-25](https://linear.app/oveglobal/issue/DEL-25):

1. **AC#1 (spec):** this spec is written, reviewed, and linked from DEL-25.
2. Tenant-host home page renders a directory of the tenant's active brands (cards / sections with brand theming).
3. Navigating into a brand sets brand context for the URL + UI (e.g., `/b/<brand-slug>`), but the cart persists across brands.
4. Add-to-cart from brand A and brand B produces `cart_items` with different `brand_id` values in the same `carts` row.
5. Checkout produces one `orders` row with `order_line_items` carrying mixed `brand_id` values.
6. Tenant-themed UI (not brand-themed) at the food-hall shell level; brand themes apply only inside brand subsections.
7. e2e: full flow on `oomi-kitchen.localhost:3001` (or equivalent demo tenant — see § "Intentional Deviation from AC#7 — demo slug").
8. Mode-1 and Mode-2 storefronts unchanged. — **See § "Intentional Deviation from Linear AC#8" below.**

## Non-Goals

- ❌ Payment integration (separate phase).
- ❌ KDS / ticketing UI (separate phase).
- ❌ Tenant onboarding flow (out of phase scope).
- ❌ Multi-location food halls (one location per checkout in this iteration; non-goal per DEL-25 issue body).
- ❌ Order history list (`/orders`) — v1 only ships the just-placed-order detail at `/orders/<id>`.
- ❌ Sticky mini-cart bar — v1 ships a "View cart (N)" link in the shell header.
- ❌ Tenant-level branding admin path — v1 uses defaults for the food-hall shell.

## Data Model Changes

**None.** DEL-24 already shipped the commerce schema (`carts`, `cart_items`, `orders`, `order_line_items`, `menus`, `menu_items`). DEL-25 is UI-only — no migrations, no schema edits, no enum changes.

The OOMI Kitchen demo data lives entirely in `packages/db/src/seed.ts` (canonical block):

```
new tenant: oomi-kitchen-test (status='active')
new brands (under oomi-kitchen-test):
  - oomi-burger-test  (brandingJson.primary = distinct hex)
  - oomi-pizza-test   (brandingJson.primary = distinct hex)
new location: oomi-kitchen (one location, food-hall single-location v1)
new location_brands: oomi-kitchen ↔ both OOMI brands (dark-kitchen)
new storefronts:
  - oomi-kitchen-test  type='tenant' (no primaryBrandId) — food-hall entry
  - oomi-burger-test   type='brand'  primaryBrandId=oomi-burger.id
  - oomi-pizza-test    type='brand'  primaryBrandId=oomi-pizza.id
new menus + menu_items: 1 menu per brand, 2 items per menu (deterministic UUIDs)
```

All idempotent via `onConflictDoNothing({ target: <pk> })` matching the DEL-24 pattern.

## API Surface

DEL-25's API surface lives in **server actions** (per AGENTS.md §Conventions — "Server actions for mutations. No /api/ routes except for auth handler and webhooks"). Actions are co-located with the route that owns them:

### PR 25b — cart actions (`apps/storefront/src/app/(shop)/cart/actions.ts`)

- `addToCartAction(formData: FormData)` — adds a line item. FormData fields: `menuItemId`, `quantity` (default 1), `currentPath` (sanitized via `safeNextPath` for the auth redirect).
- `updateCartItemQuantityAction(formData: FormData)` — adjusts quantity. FormData fields: `cartItemId`, `quantity`.
- `removeCartItemAction(formData: FormData)` — deletes a line. FormData fields: `cartItemId`.

All three actions:
1. Resolve storefront context via `resolveStorefrontTenantContext()`.
2. Verify BA session → `tenantEndUserId`. If absent, sanitize `currentPath` via `safeNextPath` and `redirect('/login?next=' + sanitized)`.
3. Validate the input row chain server-side (see "Server-side input validation" below).
4. For `addToCartAction`: call `getOrCreateActiveCart` (the only mutation path that creates a cart). For update/remove: never create.
5. Apply the DB mutation.
6. `revalidatePath('/cart')` + the concrete brand-subsection path (e.g., `revalidatePath(\`/b/${brandSlug}\`)`).

### PR 25c — checkout action (`apps/storefront/src/app/(shop)/checkout/actions.ts`)

- `placeOrderAction(formData: FormData)` — converts the active cart into an order. FormData field: `fulfillmentType: 'pickup' | 'delivery'`.

Flow inside `db.transaction(async (tx) => { ... })`:
1. Resolve session + storefront. If no session, redirect via `currentPath` + `safeNextPath`.
2. Read active cart via `getActiveCart` (read-only). If `null`, redirect to `/cart`.
3. Compute totals from cart_items.
4. Insert `orders` row (status=`'confirmed'`, fulfillmentType from input).
5. Insert `order_line_items` rows with snapshots (`name_snapshot`, `brand_name_snapshot` from joins, `menu_item_id_snapshot`, `modifiers_snapshot_json`, prices).
6. **Double-submit guard:** conditional UPDATE `UPDATE carts SET status='converted' WHERE id = $cartId AND status='active' RETURNING id`. Zero rows returned ⇒ throw to abort transaction (rolls back the order + line items, preventing a duplicate). The action surfaces a generic "this cart has already been checked out" error; no redirect to a prior order (no `source_cart_id` FK in v1 — see Open Question §7).
7. On success: `redirect('/orders/' + order.id)`.

## Server-side input validation — every mutation action

`addToCartAction(menuItemId)` cannot trust a raw `menuItemId` posted from the client — a forged ID could otherwise insert a cross-tenant cart line. Every mutation action validates the input row chain server-side **inside** the resolved tenant context:

1. Resolve storefront context → `tenantId`, `locationId` (via default location helper).
2. Fetch the `menuItem` joined to `menus → brands → location_brands`. Filter:
   - `menu_items.id = menuItemId AND menu_items.deleted_at IS NULL AND menu_items.is_active = true`
   - `menus.deleted_at IS NULL AND menus.is_active = true`
   - `brands.tenant_id = <resolved tenantId>` ← the critical cross-tenant guard
   - `brands.deleted_at IS NULL AND brands.is_active = true`
   - `location_brands.location_id = <resolved locationId>`
3. Zero rows ⇒ action throws (no redirect — adversarial input, not a UX state). The form layer surfaces "Item unavailable" without leaking why.

`updateCartItemQuantityAction` and `removeCartItemAction` additionally verify the targeted `cart_item.cart_id` resolves to a cart owned by the session's `tenantEndUserId` and the resolved `tenantId`.

## UI Sketch

```
oomi-kitchen-test.deliverse.app/                  ← food-hall directory
┌────────────────────────────────────────────────┐
│  OOMI Kitchen — Test                  [View cart]
├────────────────────────────────────────────────┤
│  ┌───────────────┐  ┌───────────────┐          │
│  │  OOMI Burger  │  │  OOMI Pizza   │          │
│  │  Smash burgers│  │  Wood-fired   │          │
│  │  & fries      │  │  pies & sides │          │
│  └───────────────┘  └───────────────┘          │
└────────────────────────────────────────────────┘

oomi-kitchen-test.deliverse.app/b/oomi-burger-test  ← brand subsection
┌────────────────────────────────────────────────┐
│  ← OOMI Kitchen                    [View cart] │
├────────────────────────────────────────────────┤
│  OOMI Burger                                   │
│  [brand-themed accent in primary color]        │
│                                                │
│  ┌────────────────────────────────┐            │
│  │ Smash Burger        $13        │  [Add]     │
│  │ Beef, lettuce, tomato          │            │
│  └────────────────────────────────┘            │
│  ┌────────────────────────────────┐            │
│  │ Truffle Burger      $17        │  [Add]     │
│  │ Truffle, mushroom              │            │
│  └────────────────────────────────┘            │
└────────────────────────────────────────────────┘

oomi-kitchen-test.deliverse.app/cart                  ← unified cart
┌────────────────────────────────────────────────┐
│  Your cart                                      │
├────────────────────────────────────────────────┤
│  OOMI Burger                                    │
│    • Smash Burger × 1                $13.00    │
│  OOMI Pizza                                     │
│    • Margherita × 2                  $28.00    │
│                                                 │
│                       Subtotal: $41.00          │
│                       [Checkout]                │
└────────────────────────────────────────────────┘

oomi-kitchen-test.deliverse.app/checkout              ← checkout
┌────────────────────────────────────────────────┐
│  Checkout                                       │
├────────────────────────────────────────────────┤
│  Fulfillment: ( ) Pickup    ( ) Delivery        │
│                                                 │
│  Order summary                                  │
│    OOMI Burger:  Smash Burger × 1   $13.00     │
│    OOMI Pizza:   Margherita × 2     $28.00     │
│                          Total:     $41.00      │
│                                                 │
│                     [Place order]               │
└────────────────────────────────────────────────┘
```

Mode 1/2 brand storefronts render the brand subsection's middle pattern (just the menu — no shell breadcrumb back to a food hall). Same component, same theming injection.

## Edge Cases

1. **Anonymous user clicks "Add to cart"** — server action sees no session, reads `currentPath` from FormData, sanitizes via `safeNextPath`, redirects to `/login?next=<sanitized>`. After login, the M1 auth UX redirects back to the brand subsection.
2. **Cross-tenant menu item ID forged** — server-side join filters by `brands.tenant_id = <resolved>`; no rows returned; action throws a generic error.
3. **User has no active cart, visits `/cart`** — `/cart` page calls `getActiveCart` (read-only, returns `null`); renders "Your cart is empty" state with a link home. **No empty cart row created** by the visit.
4. **User has no active cart, visits `/checkout`** — checkout page redirects to `/cart` (the empty-state guard).
5. **Brand soft-deleted while user has it in cart** — `cart_items.brand_id CASCADE` on hard-delete; soft-delete leaves the row queryable. v1 doesn't proactively prune; the user sees the line until they remove it.
6. **Menu item soft-deleted while in cart** — same as brand soft-delete. v1 doesn't prune.
7. **Brand subsection slug doesn't belong to this tenant** — `/b/<brandSlug>` validates `brand.tenant_id === resolvedTenantId`; `notFound()` otherwise. Cross-tenant URL probes return 404.
8. **Double-submit on checkout** — conditional UPDATE returns zero rows on the second attempt; transaction aborts and rolls back the duplicate order + line items. The action surfaces a generic error to the form. See § "Open Questions §7" for the future `source_cart_id` improvement.
9. **`/orders/<id>` accessed with a wrong user / tenant ID** — RSC verifies `order.tenantId === resolvedTenantId && order.tenantEndUserId === session.tenantEndUserId`; `notFound()` otherwise. Order IDs are never enumerable.
10. **Tenant has no active brands served by the food-hall's location** — directory renders an empty state ("No brands available"). Catastrophic for the UX but a deliberate fail-loud.
11. **`location_brands` deleted while user has items from that brand in cart** — directory hides the brand on the next visit; the user's existing cart line remains. Acceptable v1 behavior.
12. **Multiple active carts for one user (race)** — `getActiveCart` orders by `created_at DESC` and picks the most recent. App-layer pick, no DB uniqueness (DEL-24 Open Question §1).

## Intentional Deviation from Linear AC#8 ("Mode-1 and Mode-2 unchanged")

AC#8 reads "Mode-1 and Mode-2 storefronts unchanged."

Spec interprets AC#8 as **routing + auth invariance** — every existing test of brand-host routing, BA tenant resolution, cross-brand recognition disclosure, and protected-path enforcement must still pass. The M1 e2e suite is the regression gate.

Spec **does not** interpret AC#8 as "no UX progress on mode 1/2." Brand storefronts evolve from the placeholder home (`{Brand}\nWelcome. Sign in to start ordering.`) to render the brand's menu + cart UI, sharing components with mode 3 brand subsections. This is forward progress for mode 1/2 and necessary for the symmetric component design — a brand subsection inside a food hall is exactly the same UI as a standalone brand storefront. The alternative (mode 1/2 keep the placeholder) would create an asymmetry where mode-3 brand subsections have cart UI but mode-1/2 storefronts don't, even though they share `storefronts.type='brand'` semantics.

Audit trail: this section + Linear comment posted on PR 25a opening + PR 25a Risks table + the implementation plan iteration where this was reviewed.

## Intentional Deviation from Linear AC#7 — demo slug is `oomi-kitchen-test`, not `oomi-kitchen`

AC#7 says "e2e: full flow on `oomi-kitchen.localhost:3001` (or equivalent demo tenant)." Spec uses `oomi-kitchen-test`:

- Matches the established quarantine convention (`other-co-test`, `other-brand-test`).
- Reserves the bare `oomi-kitchen` slug for any future real customer (e.g., if OOMI Kitchen becomes a real tenant on the platform).
- Linear AC#7 wording explicitly allows "equivalent demo tenant" — this is the equivalent.

Documented here + in the seed file comment.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Brand-mode home evolution breaks existing M1 storefront UX expectations | Medium | Medium | Mode 1/2 e2e suite (auth + storefront-tenant-scoping) must still pass before each PR opens. Visual diff: mode 1/2 home was a placeholder; replacing it with a menu is forward progress per AC#8 interpretation. |
| Tenant-host food-hall slug collides with future tenant slug | Low | Low | Partial-unique on `storefronts.slug` enforces global uniqueness among active storefronts. `-test` suffix on the demo tenant minimizes collision surface. |
| Multi-active-cart race | Low | Low | App picks most-recent active cart per (tenantId, tenantEndUserId, locationId). DB-level uniqueness deferred per DEL-24 Open Question §1. |
| Better-Auth session not picked up by tenant-host server actions | Low | High | DEL-22 already shipped tenant-host BA in prd; stg + prd smoke confirmed. PR 25b adds an integration test: signed-up tenant-host user can add to cart. |
| Theming inline-style doesn't propagate to all Tailwind utilities | Low | Medium | Tailwind v4's `@theme` exposes `--color-*` CSS vars at `:root`; overriding on a descendant `<div style={...}>` propagates to all `bg-primary` / `text-primary` utilities. PR 25a includes a manual visual smoke. |
| Auth gate redirect loses cart intent | Medium | Low | `next=` preserves the brand-subsection URL; after login, user returns to the menu and can re-click. v2 could persist intended cart_item via search params. |
| Cross-tenant menu item ID forged | Medium | High | Server-side join filters `brands.tenant_id = <resolved>`; zero rows ⇒ action throws. Same guard on cart_item.cart_id for update/remove. |
| Double-submit on checkout creates duplicate orders | Low | High | Conditional UPDATE `WHERE status='active'` returns zero rows on the second attempt; transaction aborts and rolls back the duplicate order. |
| `/orders/<id>` cross-user enumeration | Low | High | RSC verifies tenant + user ownership; `notFound()` otherwise. |
| Inngest poller imported from another spec file | Low | Medium | PR 25c extracts the helper to `tests/e2e/helpers/inngest.ts` (non-`.spec.ts`) before reuse. |
| `auth.spec.ts` OTP rate-limit flake during 25c e2e | Medium | Low | Pre-existing flake; retry after 60s or clear `tenantOtpLockouts`. Document in PR 25c Test plan. |
| `apps/platform/next-env.d.ts` auto-modified | High | Negligible | Pre-flight `git restore`. |

## Open Questions

1. **Sticky mini-cart bar** — v1 ships a plain "View cart (N)" link in the shell header. A sticky bottom bar with item count + checkout shortcut is defensible v2 UX. Defer.
2. **Multi-location food halls** — non-goal per DEL-25; v2.
3. **Order history list (`/orders`)** — v1 only shows the just-placed order at `/orders/<id>`. Adding `/orders` (list view) is a follow-up.
4. **Cart abandonment cleanup** — DEL-24 spec deferred this. Manual `status='abandoned'` flips for now.
5. **Brand-mode home: still show a tagline / hero before the menu?** — v1 just renders the menu. A hero block could be added later via `brand.brandingJson`.
6. **Tenant-level branding (food-hall shell theme)** — v1 uses tenant defaults (the storefront-level `brandingJson` is empty for OOMI Kitchen in the seed). Adding a tenant-branding admin path is a follow-up.
7. **`orders.source_cart_id` (future schema)** — v1 has no FK from `orders` back to the `carts` row that produced it. If the double-submit recovery path ever needs to redirect a user to their previously-placed order, a future migration would add `source_cart_id uuid NULLABLE FK → carts(id) ON DELETE SET NULL` to `orders`. Not in v1 because (a) DEL-24 explicitly excluded it, (b) the v1 recovery path is a generic error rather than a redirect, and (c) it would create a one-shot use case not justified by any other consumer.
8. **`modifiers_json` shape** — untyped jsonb per DEL-24 spec. v2.

## Decisions Log

| Date | Decision | Reasoning |
|---|---|---|
| 2026-05-27 | Three PRs under one Linear issue (DEL-25) | UI surface ~3-4k lines projected. Split into seed+shell / cart / checkout — each ~1k lines, independently reviewable + revertable. Repo precedent is small PRs. |
| 2026-05-27 | Canonical seed (not fixture-gated) for `oomi-kitchen-test` | M3's Definition of Done says "live for one tenant in prd". Canonical seed gives prd a resident showcase tenant. `-test` suffix quarantines from real customer data. |
| 2026-05-27 | Mode 1/2 brand storefronts evolve to render brand menu + cart | Symmetric design: a brand subsection inside a food hall is the same UI as a standalone brand storefront. AC#8 interpreted as routing/auth invariance. |
| 2026-05-27 | Server actions (not API routes) for cart + checkout mutations | Per AGENTS.md §Conventions. Co-located with the route that owns them. |
| 2026-05-27 | Auth gate at `addToCartAction` (not at `/b/<slug>` route) | Browse freely; login prompts on action. Mirrors protected-path pattern at the route level for `/cart` / `/checkout`. |
| 2026-05-27 | Theming via inline CSS var override on a wrapper div | Tailwind v4's `@theme` exposes `--color-*` CSS vars at `:root`; descendant `style={{...}}` overrides propagate via `bg-primary` / `text-primary` utilities. No theming provider library needed. |
| 2026-05-27 | `getActiveCart` returns most-recent active cart (app-layer pick) | DEL-24 deferred DB-level cart uniqueness to v2. App picks the most recent. |
| 2026-05-27 | Single location per food-hall tenant in v1 | Non-goal per DEL-25 issue body. v1 picks the tenant's first location for cart `locationId`. |
| 2026-05-27 | Checkout fulfillment-type picker only (no payment) | Non-goal per DEL-25 issue body. v1 produces `status='confirmed'` orders. |
| 2026-05-27 | Order detail page rendered post-checkout (not list page) | v1 ships `/orders/[orderId]` only. List view is a follow-up. |
| 2026-05-27 | Brand subsection URL is `/b/<brandSlug>` | AC#3 mentions this format. `/b/` namespace keeps the route flat-and-clear vs `/<brandSlug>` which would collide with future routes. |
| 2026-05-27 | `oomi-kitchen-test` is the intentional demo slug (not `oomi-kitchen`) | `-test` matches `other-co-test` quarantine convention; reserves the bare slug for any future real customer. AC#7 wording allows "equivalent demo tenant". |
| 2026-05-27 | Read vs. create cart helpers are split | `getActiveCart` is read-only and returns `Cart \| null`; only `getOrCreateActiveCart` writes. Passive renders never create empty carts. |
| 2026-05-27 | Mutation actions validate `menuItemId` server-side through the tenant join | A raw `menuItemId` from a posted form could otherwise add a cross-tenant or unavailable item. Every action joins through `menu_items → menus → brands → location_brands` filtered by the resolved tenant + location. |
| 2026-05-27 | Server actions take an explicit `currentPath` form field, sanitized via `safeNextPath` | Server actions don't reliably see the originating pathname from headers. RSC fills a hidden `currentPath` field; action sanitizes via the existing M1 helper. |
| 2026-05-27 | Checkout uses `db.transaction` with conditional `status='active' → 'converted'` update | Without the conditional update, double-submit creates two orders. Conditional update returns zero rows on the second attempt, aborting the transaction. |
| 2026-05-27 | No redirect-to-existing-order on double-submit | No `orders.source_cart_id` FK in v1 schema. Surfacing a generic error is safer than guessing. Future `source_cart_id` migration documented as Open Question §7. |
| 2026-05-27 | `/orders/[orderId]` page verifies tenant + user ownership | Loading by ID without ownership check would let an attacker enumerate other users' orders. Always assert `order.tenantId === resolvedTenantId && order.tenantEndUserId === session.tenantEndUserId`. |
| 2026-05-27 | Inngest poller helper extracted to `tests/e2e/helpers/inngest.ts` | Importing from a `.spec.ts` may cause Playwright to collect + execute that spec in the consumer's worker. Helper lives in non-`.spec.ts`. |

---

## Files that will change (consolidated across 3 PRs)

### PR 25a — Food-hall directory + brand subsection routing + canonical seed

- `docs/specs/food-hall-storefront.md` (new — this spec)
- `packages/db/src/seed.ts` (canonical block extended — OOMI tenant + brands + location + storefronts + menus + items)
- `apps/storefront/src/app/(shop)/page.tsx` (modify — branch type='brand' renders menu, type='tenant' renders directory)
- `apps/storefront/src/app/(shop)/b/[brandSlug]/page.tsx` (new — brand subsection inside a tenant-host storefront)
- `apps/storefront/src/components/food-hall/brand-directory.tsx` (new)
- `apps/storefront/src/components/food-hall/brand-card.tsx` (new)
- `apps/storefront/src/components/menu/menu-view.tsx` (new — shared by mode 1/2 + mode 3 brand subsections)
- `apps/storefront/src/components/menu/menu-item-card.tsx` (new — with stub Add button; functional in 25b)
- `apps/storefront/src/components/food-hall-stub.tsx` (delete — replaced by directory)
- `apps/storefront/src/lib/brand-theme.ts` (new — `brandThemeStyle` helper)
- `apps/storefront/AGENTS.md` (modify — food-hall + theming notes)
- `apps/storefront/tests/e2e/storefront-host-resolution.spec.ts` (modify — DEL-20 tenant-host assertion updated to expect the directory)

### PR 25b — Unified cart UI + add-to-cart

- `apps/storefront/src/app/(shop)/cart/page.tsx` (new)
- `apps/storefront/src/app/(shop)/cart/actions.ts` (new — `addToCartAction`, `updateCartItemQuantityAction`, `removeCartItemAction`)
- `apps/storefront/src/components/cart/cart-summary.tsx` (new)
- `apps/storefront/src/components/cart/cart-line.tsx` (new — `'use client'`)
- `apps/storefront/src/components/cart/cart-link.tsx` (new — RSC, read-only `getActiveCart`)
- `apps/storefront/src/components/menu/add-to-cart-button.tsx` (new — replaces 25a stub)
- `apps/storefront/src/components/menu/menu-item-card.tsx` (modify — drop stub button, use real one)
- `apps/storefront/src/app/(shop)/page.tsx` (modify — render `cart-link` in shell header)
- `apps/storefront/src/app/(shop)/b/[brandSlug]/page.tsx` (modify — same)
- `apps/storefront/src/lib/cart-resolver.ts` (new — `getActiveCart` + `getOrCreateActiveCart` + `getDefaultLocation`)
- `apps/storefront/src/proxy.ts` (modify — add `/cart` to PROTECTED_PATHS)

### PR 25c — Checkout + food-hall e2e + DEL-25 close

- `apps/storefront/src/app/(shop)/checkout/page.tsx` (new)
- `apps/storefront/src/app/(shop)/checkout/actions.ts` (new — `placeOrderAction`)
- `apps/storefront/src/app/(shop)/orders/[orderId]/page.tsx` (new — tenant + user ownership verified)
- `apps/storefront/src/components/checkout/checkout-form.tsx` (new — `'use client'`)
- `apps/storefront/src/components/orders/order-summary.tsx` (new)
- `apps/storefront/src/components/cart/cart-summary.tsx` (modify — Checkout link)
- `apps/storefront/tests/e2e/helpers/inngest.ts` (new — extracted Inngest poller)
- `apps/storefront/tests/e2e/storefront-host-resolution.spec.ts` (modify — drop inline poller, import from helpers/)
- `apps/storefront/tests/e2e/food-hall.spec.ts` (new — full mode-3 e2e on `oomi-kitchen-test.localhost:3001`)

**Explicitly NOT modified:**

- `packages/db/src/schema.ts` — DEL-24 already shipped the commerce schema.
- `packages/db/migrations/*` — no new migrations in DEL-25.
- `packages/auth-core/*` — DEL-22 already brand-optional.
- `docs/decisions/0012-*.md` — no ADR amendment (DEL-25 implements the ADR's already-specified mode 3).
- `docs/architecture.md` / `docs/auth-spec.md` — these get the "target architecture" wording flip in DEL-27, not here.
