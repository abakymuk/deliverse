# Order Intent / Fulfillment Split (X1) — Spec v1

**Created:** 2026-05-29
**Status:** Draft
**Owner:** Vlad
**Linear:** [DEL-32](https://linear.app/oveglobal/issue/DEL-32) (Phase 4 / NEXT / X1). Folds in [DEL-33](https://linear.app/oveglobal/issue/DEL-33) (X2 actor columns). Unblocks [DEL-35](https://linear.app/oveglobal/issue/DEL-35) (X4 payments) + [DEL-37](https://linear.app/oveglobal/issue/DEL-37) (X6 KDS).
**Supersedes:** the `orders` / `order_line_items` model in [commerce-schema-v1.md](commerce-schema-v1.md) (DEL-24). Checkout flow from [food-hall-storefront.md](food-hall-storefront.md).

---

## Problem

Today a submitted order is one `orders` row with a single `order_status` enum (`pending|confirmed|preparing|ready|completed|cancelled`) that **conflates two unrelated lifecycles**: the customer's *intent* ("I placed / I cancelled") and the kitchen's *fulfillment* ("preparing / ready"). For a 3-brand food-hall order that's meaningless — "Pizza ready, Burger still preparing" has no representation, so the order is stuck at one status across all brands. It's also the structural target of the Order Intent Protocol: agent ordering should write an *intent*, not a fulfillment-coupled `orders` row. The refactor is cheap now (zero prod order volume) and a multi-week migration once KDS and real volume exist.

## Users

- **Storefront guests** — transparent. Checkout still produces "an order"; the order-detail page keeps working.
- **Platform operators** — the real beneficiary. Per-brand fulfillment tickets are the substrate X6 (KDS) renders.
- **Future agents** — the Order Intent Protocol writes `order_intents` (+ `idempotency_key`), never `orders`.
- **Analytics / payments** — X4 links `payments` to a stable `order_intent_id`; the intent total is the authoritative "what was ordered."

## Acceptance Criteria

1. **Transactional checkout** produces, in one tx: exactly **one `order_intents`** row (`status='placed'`) + **N `order_intent_items`** + **one `order_fulfillments` row per distinct `brand_id`** in the cart + the `order_fulfillment_items` links, and emits **`order_intent.placed`**.
2. **Two independent state machines** (the old flat `order_status` splits in two): *intent* status on `order_intents` (`placed→cancelled`; both terminal), and *fulfillment* status per-row on `order_fulfillments` — `queued→{preparing,cancelled}`, `preparing→{ready,cancelled}`, `ready→{completed,cancelled}`; `completed` + `cancelled` terminal. A pure validator enforces the fulfillment map; typed tests cover each valid `(from,to)` and reject invalid ones (dead-but-tested until X6).
3. **Idempotency**: two submits of the same cart create **one** `order_intents` row (the existing double-submit cart guard is preserved, plus `order_intents.idempotency_key` UNIQUE-per-tenant).
4. **Backfill**: the migration converts existing `orders` + `order_line_items` rows into the new shape with no data loss; the `orders`/`order_line_items` tables are dropped after cutover (no compat VIEW — see Decisions).
5. **Events renamed cleanly**: `order.placed`→`order_intent.placed`, `order.cancelled`→`order_intent.cancelled`. Old names are no longer emitted or present in `@rp/events`. No dual-emit.
6. **Reader migrated**: `/orders/[orderId]` + `OrderSummary` read `order_intents` (+ its fulfillments); the ownership guard (`tenantEndUserId === session.user.id`) and GDPR `SET NULL` behavior are preserved. The 3 commerce e2e specs pass against the new shape.
7. **Actors stamped** (X2 fold-in): `order_intents.placed_by_actor_type/id` + `order_modifications.actor_type/id` populated; storefront checkout stamps `tenant_end_user`.

## Non-Goals

- ❌ `payments` / `refunds` tables — land with X4 Stripe (no empty-table speculation).
- ❌ A cancellation **flow/UI** — `order_intent.cancelled` stays a schema-only stub with no emitter (same as today's `order.cancelled`).
- ❌ KDS operator UI + `order_fulfillment.status_changed` emission — that's X6.
- ❌ Real `order_modifications` write flows (partial cancel, comps, price adjustments) — the table lands now (so X4/refunds can link), but mutation flows are later.
- ❌ Splits/merges across fulfillments beyond the 1-fulfillment-per-brand default — `order_fulfillment_items` exists to allow it later; v1 maps each intent item fully to its brand's fulfillment.
- ❌ A backward-compat `orders` VIEW (see Decisions).
- ❌ Tax/fee/tip computation — still all-zero in v1, carried as columns.

## Data Model Changes

New enums:

```
order_intent_status:  placed | cancelled
fulfillment_status:   queued | preparing | ready | completed | cancelled
actor_type:           platform_user | tenant_end_user | service_account | agent | system   (X2)
fulfillment_type:     ALTER existing enum → ADD VALUE 'dine_in'  (was pickup|delivery)
```

New tables (mirroring the shipped `orders`/`order_line_items` patterns — `tenant_id` direct on the aggregate root, snapshots + `SET NULL` on brand FK, soft `menu_item_id_snapshot`):

```
order_intents                       -- the aggregate root; what the customer committed to
  id, tenant_id (FK→tenants CASCADE), location_id (FK→locations CASCADE),
  tenant_end_user_id (nullable, FK→tenant_end_users SET NULL),   -- GDPR, like orders
  channel (text, default 'storefront'),                         -- 'storefront'|'agent'|'platform' (text, NOT enum — channels proliferate; OQ7)
  placed_by_actor_type (actor_type), placed_by_actor_id (uuid, nullable),   -- X2
  idempotency_key (text, nullable),                             -- storefront writes NULL; agent/API path (L3) sets it (see Edge Case 1 / OQ3)
  subtotal_cents, tax_cents (def 0), fee_cents (def 0), tip_cents (def 0), total_cents,
  status (order_intent_status, default 'placed'),
  created_at, updated_at         -- created_at IS placement time in v1 (no draft state; placed_at dropped — see Decisions)
  UNIQUE (tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL
  INDEX (tenant_id, created_at desc), (tenant_end_user_id), (location_id)

order_intent_items                  -- immutable snapshot lines (mirror order_line_items exactly)
  id, order_intent_id (FK CASCADE),
  brand_id (nullable, FK→brands SET NULL), brand_name_snapshot (text NOT NULL),
  menu_item_id_snapshot (uuid, soft pointer), name_snapshot (text NOT NULL),
  quantity (int), modifiers_snapshot_json (ModifierSnapshot[] NOT NULL def []),
  unit_price_cents, total_cents             -- NOTE: total_cents, NOT line_total_cents
  INDEX (order_intent_id), (brand_id)

order_fulfillments                  -- one per (intent, brand); the KDS ticket + query root
  id, order_intent_id (FK CASCADE),
  tenant_id (FK→tenants CASCADE),                  -- DENORMALIZED: KDS query root (X6), like orders/carts
  brand_id (nullable, FK→brands SET NULL), brand_name_snapshot (text NOT NULL),
  location_id (FK→locations CASCADE),
  fulfillment_type (fulfillment_type), status (fulfillment_status, default 'queued'),
  estimated_ready_at (timestamptz, nullable), completed_at (timestamptz, nullable),
  created_at, updated_at
  INDEX (order_intent_id), (tenant_id, location_id, status)   -- the KDS list query

order_fulfillment_items             -- maps intent items into a fulfillment (allows future splits)
  id, order_fulfillment_id (FK CASCADE), order_intent_item_id (FK CASCADE), quantity (int)
  INDEX (order_fulfillment_id), (order_intent_item_id)

order_modifications                 -- table only; mutation flows are out of scope (see Non-Goals)
  id, order_intent_id (FK CASCADE), kind (text), actor_type (actor_type), actor_id (uuid nullable),
  payload (jsonb), applied_at (timestamptz, default now()), financial_delta_cents (int, default 0)
  INDEX (order_intent_id)
```

Dropped after cutover (in `0011`, **after** the row-count assertion): `orders`, `order_line_items`, and the `order_status` enum (verified used **only** by `orders.status` → safe to drop). Seed data does **not** insert `orders` (verified) — no seed change.

**Backfill** (trivially small; dev/stg only, prd has none): each `orders` row → one `order_intents` (`status='cancelled'` iff old `status='cancelled'`, else `'placed'`; `placed_by_actor_type='tenant_end_user'` when `tenant_end_user_id` present else `'system'`) + one `order_fulfillments` per distinct line-item `brand_id` (`status` mapped: `pending|confirmed→queued`, `preparing→preparing`, `ready→ready`, `completed→completed`, `cancelled→cancelled`). `order_line_items`→`order_intent_items` 1:1 (snapshots copy verbatim); each item linked into its brand's fulfillment via `order_fulfillment_items`.

## API Surface

```
- placeOrderAction(formData)  [REFACTOR, apps/storefront/.../checkout/actions.ts]
    same tx: load cart lines → totals → INSERT order_intents (1)
           → INSERT order_intent_items (N) → INSERT order_fulfillments (1/brand)
           → INSERT order_fulfillment_items → appendEvent(tx, order_intent.placed)
           → double-submit cart guard (unchanged) → return orderIntentId
    redirect('/orders/<orderIntentId>') after tx commits (unchanged pattern)

- event "order_intent.placed"  [RENAME of order.placed; @rp/events/schema.ts]
    payload: { ...base (tenantId, occurredAt, actorType, actorId, correlation/causation),
               orderIntentId, cartId|null, locationId,
               totalCents, subtotalCents, brandIds[], lineItemCount }
    DROPPED vs order.placed: fulfillmentType (now per-fulfillment)

- event "order_intent.cancelled"  [RENAME of order.cancelled; schema-only stub, no emitter]
    payload: { ...base, orderIntentId, reason|null }

- writer.ts: aggregate_type 'order'→'order_intent'; idempotency-key derivation
    order_intent.placed→orderIntentId, order_intent.cancelled→`${orderIntentId}:cancelled`
```

## UI Sketch

```
/orders/[orderId]  → page reads order_intents by id (was: orders), ownership guard unchanged
  └── <OrderSummary orderIntentId={...} />
        SELF-FETCHING RSC: retarget its internal query order_line_items → order_intent_items
        (keep the self-fetch contract; do NOT convert to prop-driven).
        MAY also fetch + render per-brand fulfillment status chips — optional in X1;
        full KDS-driven status UX is X6.
```

## Edge Cases

1. **Double submit** — **storefront** relies solely on the existing conditional `UPDATE carts SET status='converted' WHERE status='active'` (zero rows ⇒ rollback) and writes `idempotency_key = NULL` (the partial-unique index ignores NULLs — consistent with the outbox pattern). The `order_intents.idempotency_key` UNIQUE-per-tenant is the **agent/API** dedup (L3): a set-key conflict resolves `ON CONFLICT DO NOTHING` + returns the existing intent. v1 ships the column + index; the agent write path is out of scope. **Note:** this is distinct from `event_outbox.idempotency_key` (the don't-double-publish guard, derived `= orderIntentId`).
2. **Empty cart** — guard before tx (redirect to `/cart`), unchanged.
3. **GDPR single-user delete** — `order_intents.tenant_end_user_id` is `SET NULL` (like `orders`); anonymized intents survive and are inaccessible (NULL never matches a session id). Tenant hard-delete cascades via `tenant_id`.
4. **Multi-brand fan-out** — N distinct brands ⇒ N `order_fulfillments`; a single-brand order ⇒ 1. Brand identity preserved via `brand_name_snapshot` after `SET NULL`.
5. **Brand/menu-item hard-delete after order** — snapshots (`brand_name_snapshot`, `menu_item_id_snapshot`, `name_snapshot`, `modifiers_snapshot_json`) carry the record forward; FKs `SET NULL`/soft.
6. **Backfilled cancelled orders** — intent `cancelled` + all fulfillments `cancelled`.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Reader/test drift after dropping `orders` | M | M | Single in-repo reader + 3 e2e specs; migrate all in the same PR; typecheck catches the rest |
| `order.*`→`order_intent.*` rename breaks an unseen consumer | L | M | Grep confirms only emitter is `placeOrderAction`; outbox/dispatcher are name-agnostic; no event subscribers exist |
| `ALTER TYPE fulfillment_type ADD VALUE 'dine_in'` under the transactional migrator | L | L | PG12+/Neon allows `ADD VALUE` inside a tx; only rule is you can't *use* the new value in the same tx, and the backfill never writes `dine_in` — safe under `migrate.ts`'s per-file tx |
| Backfill mis-maps status | L | L | Dataset is a handful of dev/stg rows; assert counts post-migration; prd has zero orders |
| Scope creep into KDS/cancellation/modifications | M | M | Hard Non-Goals; tables land empty-of-flow, UI is X6 |

## Open Questions

_All resolved 2026-05-29 (see Decisions Log):_
- ~~`event_outbox.actor_type` stays `text`?~~ → **Yes**, keep the asymmetry (log = text, structured columns = enum).
- ~~Emit a fulfillment event at checkout?~~ → **No**, leave all fulfillment events to X6; X1 emits only `order_intent.placed`.
- ~~`channel='storefront'`?~~ → **Yes**; `channel` stays `text` (not an enum).

## Decisions Log

| Date | Decision | Reasoning |
|---|---|---|
| 2026-05-29 | **Clean cutover, no compat `orders` VIEW** | Exactly one in-repo reader + 3 e2e tests + zero prod order volume; a VIEW synthesizing one `status` from per-brand fulfillments would be lossy and pure overhead |
| 2026-05-29 | **Clean event rename, no dual-emit** | No external consumers; only emitter is `placeOrderAction`; dispatcher is name-agnostic. (Overrides the conservative dual-emit note in `@rp/events/schema.ts:119`) |
| 2026-05-29 | **Drop `fulfillmentType` from `order_intent.placed`** | Fulfillment type is now per-`order_fulfillments` row (and gains `dine_in`); the intent event shouldn't carry a single order-wide value |
| 2026-05-29 | **`order_intent_items` mirrors `order_line_items` naming** | Reuse the shipped snapshot pattern incl. `total_cents` (not `line_total_cents`) + `brand_name_snapshot`; reduces churn and cognitive load |
| 2026-05-29 | **Reuse `fulfillment_type` enum + ADD `dine_in`** | One enum for the concept; `carts` keeps using it; additive `ALTER TYPE` is cheap |
| 2026-05-29 | **X2 folds in here** | Outbox + event actor columns already shipped in N2; only the new structured columns + `actor_type` enum remain — do them with the tables that need them |
| 2026-05-29 | **`order_fulfillments` carries denormalized `tenant_id`** (+ index `(tenant_id, location_id, status)`) | Fulfillments are the KDS query root (X6); joining through `order_intents` on every query + no `(tenant_id,status)` index is the wrong default. Matches `orders`/`carts` denormalization |
| 2026-05-29 | **Storefront `idempotency_key = NULL`** | Cart-conversion guard is the sole storefront dedup; UNIQUE key reserved for the agent/API path (ON CONFLICT DO NOTHING + return existing) |
| 2026-05-29 | **Drop `placed_at`; `created_at` is placement time in v1** | Intent is born `placed` (no draft state); placed_at would always equal created_at. Re-add additively if a scheduled/draft state lands |
| 2026-05-29 | **Migration `0011` is atomic: DDL → backfill → assertion → DROP** | A `DO`-block row-count assertion before the drops fails loudly on a backfill mismatch; zero prod volume makes a single atomic migration safe |
| 2026-05-29 | **`actorTypeEnum` declared in exact `@rp/events` Zod order + parity test** | pgEnum declaration order = the type's sort order; a parity test (in `@rp/events`) prevents silent drift between the pg enum and the Zod enum |

---

## Files that will change

- `packages/db/src/schema.ts` — add `orderIntentStatusEnum`, `fulfillmentStatusEnum`, `actorTypeEnum`; `ALTER` `fulfillmentTypeEnum` (+`dine_in`); add 5 tables; remove `orders`/`orderLineItems` (+ `orderStatusEnum` if unused).
- `packages/db/migrations/0011_*.sql` — DDL + idempotent backfill + drop old tables (drizzle-kit generate, then hand-add backfill UPDATEs/INSERTs before the drops; cf. DEL-30's `0010` backfill pattern).
- `packages/events/src/schema.ts` — rename symbols (`orderPlaced`/`orderCancelled`) **and** wire literals (`'order.placed'`→`'order_intent.placed'`, etc.); new payloads; `domainEvent` union; **`export const actorType`**; delete the dual-emit comments (`:119-122`, `:140-143`).
- `packages/events/src/types.ts` — `OrderPlaced`/`OrderCancelled` aliases, `…Data` types, **`EventDataMap` keys**, `_ExhaustiveCheck` guard.
- `packages/events/src/index.ts` — barrel re-exports of the renamed value symbols + type names.
- `packages/events/src/writer.ts` — `aggregate()` + `idempotencyKey()` switches (`order`→`order_intent`; `event.data.orderId`→`orderIntentId`). Both switches are `tsc`-exhaustiveness-protected.
- `packages/events/src/writer.test.ts` **and** `packages/events/tests/outbox-transactional.test.ts` — order-event fixtures (the main ones are in `src/`, not `tests/`).
- `packages/db/src/fulfillment-status.ts` (new, client-free) + `packages/db/package.json` `exports` (`"./fulfillment-status"`) — fulfillment status-transition map + validator.
- Comment sweep: `packages/db/src/schema.ts:1138` + `apps/storefront/.../checkout/actions.ts:145-146`.
- `apps/storefront/src/app/(shop)/checkout/actions.ts` — refactor `placeOrderAction` to the intent+fulfillment writes + renamed event.
- `apps/storefront/src/app/(shop)/orders/[orderId]/page.tsx` + `src/components/orders/order-summary.tsx` — read `order_intents` (+ fulfillments) instead of `orders`.
- `apps/storefront/tests/e2e/{food-hall,commerce-schema,mode-1-single-brand}.spec.ts` — update inserts/assertions to the new tables.
- `packages/db/src/seed*` / seed data — if it inserts `orders` (verify).
- `AGENTS.md` — only if a convention changes (likely none).
