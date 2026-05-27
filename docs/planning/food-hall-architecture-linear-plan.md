# Food Hall Architecture Alignment — Linear Plan

**Created:** 2026-05-26
**Status:** Draft
**Owner:** Vlad
**Source of truth:** [ADR-0012 — Storefront, Brand, Tenant, and Food Hall Architecture](../decisions/0012-storefront-brand-tenant-food-hall-architecture.md)

This document captures the delivery plan to take the platform from its current M1 brand-first storefront to the [ADR-0012](../decisions/0012-storefront-brand-tenant-food-hall-architecture.md) target architecture. It is **not** a substitute for Linear — it is the staging document the user converts into Linear project / milestone / issue records when the timing is right.

> **Why a planning doc and not Linear issues yet.**
> Per [`docs/linear-workflow.md`](../linear-workflow.md), only one Urgent project is allowed at a time. Phase 1 — Auth Vertical is currently the workspace's single Urgent project; opening another Urgent project would violate that invariant. Phase number, target dates, priority, and milestone ordering are decisions for the user, not Claude. This doc holds the structured draft until then.

---

## Project (proposed)

| Field | Value |
|---|---|
| **Name** | `Phase <N> — Food Hall Architecture Alignment` (N picked by user) |
| **Priority** | High by default; Urgent only after Phase 1 closes |
| **Lead** | Vlad |
| **Team** | deliverse |
| **References** | [ADR-0012](../decisions/0012-storefront-brand-tenant-food-hall-architecture.md), [ADR-0003](../decisions/0003-tenant-scoped-end-users.md), [ADR-0010](../decisions/0010-tenant-scoping-injection.md) |

### Project description (drop into the Linear `description` field)

**Why now**

The platform's identity model is already correctly tenant-scoped (ADR-0003), but the application shell hard-binds storefront ↔ brand. As a result, mode 3 (tenant-level food halls with unified multi-brand carts — e.g., OOMI Kitchen → OOMI Burger + Pizza + Bowls + Wings) is not representable end-to-end. With no commerce data model yet, the cheapest moment to land the correct architecture is before the first commerce migration ships.

**Definition of Done**

- `storefronts` table exists; one row per existing brand of `type='brand'` backfilled; routing-layer can resolve a host to either a brand storefront or a tenant storefront.
- `tenant_end_user_sessions.current_brand_id` is nullable; food-hall sessions store NULL; brand-mode sessions store a UUID.
- Storefront BA tenant context is brand-optional; tenant-host requests no longer return HTTP 400; tenant scoping remains enforced on every request.
- Commerce schema (carts, cart_items, orders, order_line_items, menus, menu_items) exists with the ADR-0012 §6 shape — `brand_id` lives on line items, not on cart/order.
- Food-hall storefront shell is live for at least one demo tenant; cart spans brands; checkout produces one order.
- All three modes (single-brand, multi-brand separate, food hall) have e2e coverage and pass.
- Architecture and auth-spec docs reflect mode-3 as supported (post-implementation cleanup of "target architecture" wording).

**Scope**

- Schema additions: `storefronts`, commerce tables, nullability migration on `current_brand_id`.
- Auth: storefront tenant-context resolver + wrapped adapter become brand-optional.
- Routing: proxy + host resolver become storefront-aware.
- UI: food-hall storefront shell + unified-cart UX.
- Tests: cross-mode invariants.

**Non-goals**

- ❌ Auto-sharing customer preferences across brands without explicit consent.
- ❌ Breaking `{brand}.deliverse.app` storefronts.
- ❌ Removing support for single-brand tenants.
- ❌ Cross-tenant account linking.
- ❌ Brand sale / customer-data migration between tenants (v2).

**References**

- [ADR-0012](../decisions/0012-storefront-brand-tenant-food-hall-architecture.md) — source of truth for the target architecture.
- [ADR-0003](../decisions/0003-tenant-scoped-end-users.md) — tenant-scoped identity invariant.
- [ADR-0010](../decisions/0010-tenant-scoping-injection.md) — current adapter contract (will be amended).
- [`docs/specs/storefront-tenant-scoping.md`](../specs/storefront-tenant-scoping.md), [`docs/specs/del-15-storefront-baseurl.md`](../specs/del-15-storefront-baseurl.md), [`docs/specs/del-12-account-tenant-scoping.md`](../specs/del-12-account-tenant-scoping.md).

---

## Milestones (proposed)

| Code | Outcome | Notes |
|---|---|---|
| M1 | Storefront concept + brand-optional auth — architecture serves tenant-host requests without 400 | Schema + routing + auth refactor. Issues 1-6 + 9. |
| M2 | Commerce schema with brand-on-line-item shape lands; one cart / one order can span brands | Issue 7 + e2e from 9. Can run in parallel with M1's auth work. |
| M3 | Food-hall storefront shell live for one tenant in prd; mode 3 demonstrably works | Issue 8 + final 9 + doc cleanup (10). |

Milestone cardinality matches `linear-workflow.md` §"Milestone shape" guidance (1-3 per project).

---

## Issues

Each issue draft follows the `linear-workflow.md` §"Issue shape" template: Why, Acceptance criteria (AC#1 is always the spec for features), Files that will change, Non-goals, Dependencies. ADR numbers are **not** pinned in issue bodies per the workflow's anti-collision rule, except for ADR-0012 which already exists.

### 1. Create ADR-0012 — Storefront, Brand, Tenant, Food Hall Architecture

- **Why:** Architectural baseline for all subsequent work. Must precede schema/auth/routing changes.
- **Acceptance criteria:**
  1. ADR present at `docs/decisions/0012-storefront-brand-tenant-food-hall-architecture.md`.
  2. ADR linked from `docs/decisions/README.md`.
  3. AGENTS.md decision-log highlights reference ADR-0012.
  4. Dependent docs (architecture.md, auth-spec.md, storefront-tenant-scoping.md, del-15-storefront-baseurl.md, apps/storefront/AGENTS.md) link to ADR-0012.
- **Files that will change:** `docs/decisions/0012-*.md` (new), `docs/decisions/README.md`, `AGENTS.md`, `docs/architecture.md`, `docs/auth-spec.md`, `docs/specs/storefront-tenant-scoping.md`, `docs/specs/del-15-storefront-baseurl.md`, `apps/storefront/AGENTS.md`, `docs/planning/food-hall-architecture-linear-plan.md` (this file).
- **Non-goals:** any schema, auth, or routing implementation.
- **Dependencies:** none.
- **Risk:** Low.
- **Labels:** `Feature` + `docs`.
- **Note:** This issue tracks the ADR landing. When Step 2 of the audit-and-plan flow completes, this issue is `Done`.

---

### 2. Introduce first-class `storefronts` table

- **Why:** ADR-0012 requires a first-class storefront entity separating URL/shell from brand identity. This is the lowest-risk first step — additive schema with no behavior change.
- **Acceptance criteria:**
  1. **AC#1 (spec):** `docs/specs/storefronts-model.md` written, reviewed, and linked from this issue.
  2. Migration adds `storefronts(id, tenant_id, slug UNIQUE, name, type, primary_brand_id, branding_json, created_at, updated_at, deleted_at)` with appropriate FKs and indexes per ADR-0012 §"Storefront model (target)".
  3. Backfill creates one row of `type='brand'` per existing active brand, with `primary_brand_id` set and `slug` matching the current brand slug.
  4. Routing layer untouched in this issue — proxy still uses `extractBrandSlug` (Issue 3 changes routing).
  5. Drizzle relations + types exported from `@rp/db`.
  6. Seed script (`packages/db/src/seed.ts`) updated to create a storefront per seeded brand.
  7. Existing e2e + integration tests pass unchanged.
- **Files that will change:** `packages/db/src/schema.ts`, new `packages/db/migrations/000N_*.sql`, `packages/db/src/seed.ts`, `docs/specs/storefronts-model.md`.
- **Non-goals:** routing/auth/proxy changes; tenant-host functionality.
- **Dependencies:** blockedBy Issue 1.
- **Risk:** Medium (additive schema; backfill must be idempotent).
- **Labels:** `Feature` + `db` + `docs`.

---

### 3. Storefront-aware host resolution (proxy + resolver)

- **Why:** Routing must resolve a Host to a storefront, not just a brand. This enables tenant-host food-hall storefronts to enter the app shell.
- **Acceptance criteria:**
  1. **AC#1 (spec):** `docs/specs/storefront-host-resolution.md` written, reviewed, and linked from this issue.
  2. New `extractStorefrontSlug(host, baseDomain)` in `@rp/auth-core` returns the storefront slug, replacing the brand-only extractor.
  3. New `resolveStorefrontBySlug(slug)` returns `{ storefrontId, tenantId, brandId?: string, storefrontType: 'brand' | 'tenant' }`.
  4. Storefront proxy injects `x-storefront-id` (and continues to inject `x-brand-slug` only when `type='brand'`).
  5. Brand-host requests behave **identically** to today — full M1 e2e suite passes unchanged.
  6. Tenant-host requests return 200 from the home route (food-hall page exists but is stub-rendered; full UX is Issue 8).
  7. Reserved subdomains (`www`, `admin`, `api`, `app`) still bypass storefront resolution.
- **Files that will change:** `packages/auth-core/src/storefront-host.ts`, new `packages/auth-core/src/storefront-resolver.ts`, `apps/storefront/src/proxy.ts`, `apps/storefront/src/lib/tenant-resolution.ts`, `apps/storefront/src/app/(shop)/page.tsx` (stub mode-3 path).
- **Non-goals:** session schema change; BA resolver change; UI shell.
- **Dependencies:** blockedBy Issue 2.
- **Risk:** Medium-High (touches every request; full e2e suite must pass).
- **Labels:** `Feature` + `auth` + `e2e`.

---

### 4. Make `tenant_end_user_sessions.current_brand_id` nullable (schema + adapter)

- **Why:** Food-hall sessions have no single brand. ADR-0012 §"Session model (target)" makes `current_brand_id` optional. Pairs the schema migration with the adapter write change so the field shape and adapter behavior stay consistent.
- **Acceptance criteria:**
  1. **AC#1 (spec):** `docs/specs/session-brand-optional.md` written, reviewed, and linked from this issue.
  2. Migration changes `tenant_end_user_sessions.current_brand_id` to NULLABLE; existing sessions retain their UUID; no data loss.
  3. Adapter writes UUID for brand-mode sessions and NULL for tenant-mode sessions.
  4. Read path: any session with NULL `current_brand_id` resolves to tenant context only (no brand).
  5. Adapter unit tests cover both modes.
- **Files that will change:** `packages/db/src/schema.ts`, new `packages/db/migrations/000N_*.sql`, `packages/auth-core/src/storefront-adapter.ts`, `docs/specs/session-brand-optional.md`.
- **Non-goals:** UI changes; food-hall flow.
- **Dependencies:** blockedBy Issue 3.
- **Risk:** Medium.
- **Labels:** `Feature` + `db` + `auth`.

---

### 5. Brand-optional Better-Auth resolver + adapter

- **Why:** ADR-0010's brand-required behavior blocks tenant-host requests at the BA layer. ADR-0012 §"Auth tenant resolution" requires the resolver + adapter to be tenant-required and brand-optional.
- **Acceptance criteria:**
  1. **AC#1 (spec):** `docs/specs/ba-brand-optional.md` written, reviewed, and linked from this issue.
  2. Resolver returns `{ tenantId, storefrontId, storefrontType, brandId? }`.
  3. Wrapped adapter stamps `current_brand_id` / `brand_id` on writes only when `brandId` is present; tenant scoping (`tenant_id`) is unchanged.
  4. BA returns 400 only when tenant is unresolvable; absence of `brandId` is NOT an error.
  5. ADR-0010 receives an `## Amendment` block citing this issue + ADR-0012.
  6. All §6 auth-spec acceptance criteria pass for both brand-host and tenant-host modes.
  7. OAuth signup/login still works in brand-host mode (regression test).
- **Files that will change:** `packages/auth-core/src/storefront-adapter.ts`, `packages/auth-core/src/storefront-tenant-resolver.ts`, `apps/storefront/src/lib/storefront-tenant-context.ts`, `packages/auth-core/src/storefront-url.ts` (tenant-host baseURL path), `docs/decisions/0010-tenant-scoping-injection.md` (amendment), `docs/specs/ba-brand-optional.md`.
- **Non-goals:** UI; commerce; food-hall shell.
- **Dependencies:** blockedBy Issues 3, 4.
- **Risk:** High (M1 auth surface change; tenant-isolation tests must still pass).
- **Labels:** `Feature` + `auth` + `e2e`.

---

### 6. Conditional verification `brand_id` stamping

- **Why:** Verification rows (OTP / password reset) currently get `brand_id` stamped unconditionally by the adapter. Tenant-host OTPs should leave it NULL.
- **Acceptance criteria:**
  1. **AC#1 (spec):** `docs/specs/verification-brand-optional.md` written, reviewed, and linked from this issue.
  2. OTP request from brand-host storefront → verification row has `brand_id` UUID.
  3. OTP request from tenant-host storefront → verification row has `brand_id` NULL.
  4. OTP email branding falls back to tenant default when `brand_id` is NULL.
  5. End-to-end: tenant-host OTP signup works in dev.
- **Files that will change:** `packages/auth-core/src/storefront-adapter.ts`, `packages/emails/src/*` (tenant-default branding), `docs/specs/verification-brand-optional.md`.
- **Non-goals:** UI shell.
- **Dependencies:** blockedBy Issue 5.
- **Risk:** Medium.
- **Labels:** `Improvement` + `auth` + `e2e`.

---

### 7. Commerce schema — carts/orders tenant-scoped, brand on line items

- **Why:** First commerce migration must lock in the ADR-0012 §"Commerce model" shape. Adding `brand_id` to `carts` or `orders` would either block mode 3 or force a "primary brand" hack later.
- **Acceptance criteria:**
  1. **AC#1 (spec):** `docs/specs/commerce-schema-v1.md` written, reviewed, and linked from this issue.
  2. Migrations create `carts`, `cart_items`, `orders`, `order_line_items`, `menus`, `menu_items` with shape per ADR-0012 §6.
  3. `carts` has NO `brand_id` column; `orders` has NO `brand_id` column.
  4. `cart_items.brand_id` is NOT NULL; `order_line_items.brand_id` is NOT NULL.
  5. `menus.brand_id` FK to brands; tenant-safety via `brand.tenant_id`.
  6. Drizzle relations + types exported; seed script updated with at least one tenant having multiple brands sharing one cart.
  7. Integration test: create cart with line items from 2 brands, check out, single order with mixed `brand_id` line items.
- **Files that will change:** `packages/db/src/schema.ts`, new `packages/db/migrations/000N_*.sql`, `packages/db/src/seed.ts`, `docs/specs/commerce-schema-v1.md`.
- **Non-goals:** UI; checkout flow; payment integration.
- **Dependencies:** blockedBy Issue 1 (architectural alignment). NOT blocked by Issues 2-6 — data layer is independent of routing/auth and can land in parallel.
- **Risk:** Medium (greenfield; no compat surface).
- **Labels:** `Feature` + `db` + `docs`.

---

### 8. Food-hall storefront shell — spec + implementation

- **Why:** Mode 3's user-visible feature. Requires Issues 5 (brand-optional BA) and 7 (commerce schema) to be green.
- **Acceptance criteria:**
  1. **AC#1 (spec):** `docs/specs/food-hall-storefront.md` written, reviewed, and linked from this issue.
  2. Tenant-host home page renders a directory of the tenant's active brands.
  3. Navigating into a brand sets brand context for that subsection (URL + UI), but the cart persists across brands.
  4. Add-to-cart from brand A and brand B produces `cart_items` with different `brand_id` values in the same cart row.
  5. Checkout produces one `orders` row with `order_line_items` carrying the mixed `brand_id` values.
  6. Tenant-themed UI (not brand-themed) at the food-hall shell level; brand themes apply only inside brand subsections.
  7. e2e: full flow on `oomi-kitchen.localhost:3001` (or equivalent demo tenant).
- **Files that will change:** new layout/page tree under `apps/storefront/src/app/...`, `packages/ui/src/...` food-hall components, `docs/specs/food-hall-storefront.md`.
- **Non-goals:** payment integration; KDS UI; tenant onboarding flow.
- **Dependencies:** blockedBy Issues 5, 7.
- **Risk:** Medium-High (largest UI surface in the project).
- **Labels:** `Feature` + `ui` + `e2e`.

---

### 9. Test coverage — single-brand, multi-brand, food-hall invariants

- **Why:** The three modes must pass simultaneously. Tests must cover the matrix; tenant-isolation tests must still pass.
- **Acceptance criteria:**
  1. **AC#1 (spec):** `docs/specs/food-hall-test-matrix.md` written, reviewed, and linked from this issue.
  2. e2e: mode 1 (single-brand tenant) flow passes on a single-brand seeded tenant.
  3. e2e: mode 2 (separate brand storefronts) flow passes — cross-brand recognition disclosure renders; same email logs in across two brands of one tenant.
  4. e2e: mode 3 (food hall) flow passes — multi-brand cart, single checkout, single order with brand-tagged line items.
  5. Tenant-isolation tests still pass — email at tenant A and tenant B are independent in all modes.
  6. Brand cookie-leak tests still pass — cookies scoped to exact storefront slug.
- **Files that will change:** `apps/storefront/tests/e2e/*.spec.ts` (new specs alongside existing ones), `packages/db/src/seed.ts` (additional fixtures), `docs/specs/food-hall-test-matrix.md`.
- **Non-goals:** load testing; visual regression.
- **Dependencies:** relatedTo Issues 3-8 (lands incrementally; final pass after Issue 6).
- **Risk:** Medium.
- **Labels:** `Feature` + `e2e` + `docs`.

---

### 10. Update docs after food-hall implementation lands

- **Why:** Step 2 of the audit-and-plan flow already added ADR-0012 cross-references and "target architecture" framing. This issue is post-implementation cleanup, not the same alignment work — it flips wording from "target" to "current state" once mode 3 actually works.
- **Acceptance criteria:**
  1. `docs/architecture.md` updated: mode 3 listed as supported; "not yet implemented" caveat removed.
  2. `docs/auth-spec.md` updated: §6 acceptance criteria expanded to cover the three modes; M1 caveat removed from §5.
  3. `docs/specs/storefront-tenant-scoping.md` updated: "Evolution note" removed or rewritten to reflect current behavior.
  4. `docs/specs/del-15-storefront-baseurl.md` updated: tenant-host baseURL documented as live.
  5. `apps/storefront/AGENTS.md` routing description refreshed.
- **Files that will change:** `docs/architecture.md`, `docs/auth-spec.md`, `docs/specs/storefront-tenant-scoping.md`, `docs/specs/del-15-storefront-baseurl.md`, `apps/storefront/AGENTS.md`.
- **Non-goals:** code changes; spec rewrites for features in flight.
- **Dependencies:** blockedBy Issues 3-8 (cannot land until food-hall behavior is real in prd).
- **Risk:** Low.
- **Labels:** `Improvement` + `docs`.

---

## Dependency graph

```
1 (ADR)
 ├── 2 (storefronts table)
 │     └── 3 (host resolution)
 │           └── 4 (nullable current_brand_id + adapter)
 │                 └── 5 (BA brand-optional)
 │                       └── 6 (verification brand stamping)
 │                             └── 8 (food-hall shell)  ←── also needs 7
 └── 7 (commerce schema)  [parallel-safe with 2-6]
        └── 8

9 (tests) — relatedTo 3-8, lands incrementally
10 (doc cleanup) — blockedBy 3-8
```

Issues 2 and 7 can run in parallel (both block on Issue 1 only). Issues 3 → 4 → 5 → 6 are sequential. Issue 8 needs both 6 and 7. Issue 9 piggybacks on each implementation issue's PR and gets a final consolidation pass after Issue 6. Issue 10 is post-prd cleanup.

---

## Risk summary

| Tier | Issues | Notes |
|---|---|---|
| **Low** | 1, 10 | Doc-only. |
| **Medium** | 2, 4, 6, 7, 9 | Additive schema or local change; manageable e2e surface. |
| **High** | 3, 5 | Touch every storefront request; M1 compatibility critical. Both require full e2e re-run before merge. |
| **Medium-High** | 8 | Largest UI surface; depends on 5 + 7 holding. |

Cross-cutting compatibility constraint: **tenant isolation is non-negotiable in all modes.** No path may bypass the tenant scoping predicate in the wrapped adapter. Every issue that touches the adapter must keep ADR-0010's tenant-scoping invariant intact and add tenant-isolation tests where appropriate.

---

## When to convert this doc into Linear

When the user is ready to commit to the work:

1. Open `docs/linear-workflow.md` and follow §"MCP discipline" (list before create, capture IDs, append-only relations).
2. Create the project record (name + description from the section above).
3. Create three milestones (M1 / M2 / M3) on that project.
4. Create issue records 1-10, copying Why / AC / Files / Non-goals / Dependencies from each draft above. Replace ADR placeholder language with concrete numbers where ADRs already exist (ADR-0010, ADR-0012).
5. Mark Issue 1 as `Done` if Step 2 of the audit-and-plan flow has already shipped the ADR + docs.
6. Promote one issue to `Todo` per the workflow's "at most one issue in Todo at a time" rule.
