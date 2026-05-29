# @rp/events

Domain event substrate: Zod schemas for every event the platform emits, a transactional outbox writer, and the Inngest cron dispatcher that drains the outbox.

## What it is

- **`./schema`** — Zod definitions of every domain event. Single source of truth for event shape. Discriminated union (`domainEvent`) lets consumers exhaustive-switch on `name`.
- **`./writer`** — `appendEvent(tx, event)` and `appendEventAfterCommit(event)`. The only two ways to land an event row.
- **`./inngest`** — exports the `outboxDispatcher` Inngest cron function. Registered ONCE in `apps/platform/src/app/api/inngest/route.ts` per ADR-0009 §5.

## Events

| Event name | Producer | Aggregate |
|---|---|---|
| `guest.signed_up` | `packages/auth-core/src/storefront-adapter.ts` (`user.create` → `queueAfterTransactionHook`) | `guest` |
| `guest.signed_in` | `packages/auth-core/src/storefront-adapter.ts` (`session.create` → `queueAfterTransactionHook`) | `guest` |
| `cart.item_added` | `apps/storefront/src/app/(shop)/cart/actions.ts` (`addToCartAction`, in-tx) | `cart` |
| `order_intent.placed` | `apps/storefront/src/app/(shop)/checkout/actions.ts` (`placeOrderAction`, in-tx) | `order_intent` |
| `order_intent.cancelled` | _schema-only stub_ — no emission site yet (the cancel flow doesn't exist) | `order_intent` |
| `payment.captured` | `packages/payments/src/handlers.ts` (`handlePaymentIntentSucceeded`, in-tx) | `payment` |
| `payment.refunded` | `packages/payments/src/handlers.ts` (`handleChargeRefunded`, in-tx) | `payment` |

The order events were renamed `order.*` → `order_intent.*` in DEL-32 / X1 (Order Intent split) — a clean hard-rename (no dual-emit; there were zero live consumers).

## Versioning rules

- **Additive optional fields → stay on `event_version=1`.** Consumers tolerate unknown optional fields by default.
- **Breaking changes (removed fields, renamed fields, semantic shifts) → bump `event_version`.**
- **Deprecation lifecycle:** when an event is renamed, the producer emits BOTH names for one minor-version window with `event_version` bumped on the new name. Consumers migrate. Old name removed in the following release.

## Naming convention

Dot-notation: `<aggregate>.<action>` (`guest.signed_up`, `order_intent.placed`). Matches the `@rp/emails` event convention. No abbreviations.

## Writer pattern (in-tx)

For mutations the application owns:

```ts
import { appendEvent } from '@rp/events/writer';
import { db } from '@rp/db';

await db.transaction(async (tx) => {
  const [row] = await tx.insert(cartItems).values({...}).returning();
  await appendEvent(tx, {
    name: 'cart.item_added',
    data: {
      tenantId, occurredAt: new Date().toISOString(),
      actorType: 'tenant_end_user', actorId: userId,
      cartId, cartItemId: row.id, brandId, menuItemId,
      quantity, unitPriceCents, locationId,
    },
  });
});
```

## Writer pattern (after-commit, for BA hooks)

For paths where Better-Auth owns the transaction:

```ts
import { appendEventAfterCommit } from '@rp/events/writer';
import { queueAfterTransactionHook } from '@better-auth/core/context';

queueAfterTransactionHook(async () => {
  try {
    await appendEventAfterCommit({ name: 'guest.signed_up', data: {...} });
  } catch (err) {
    // CRITICAL: never throw — BA's tx already committed; the user-facing
    // op succeeded. Letting this propagate trashes the 200 with a 500.
    console.error('[outbox] queueAfterTransactionHook append failed', { err });
  }
});
```

The post-commit hook fires after BA's tx commits (or immediately if the path isn't wrapped in a tx). If BA's tx rolls back, the hook never runs — guarantee: "outbox row appended only if user/session committed."

## Consumer registration

Future consumers of dispatched events live under `packages/events/src/inngest/consumers/`. Each:

1. Lives in `packages/events/src/inngest/consumers/<name>.ts`.
2. Is exported from `packages/events/src/inngest/index.ts`.
3. Is registered in `apps/platform/src/app/api/inngest/route.ts` by appending to the `functions` array.
4. Reads `event.data._meta.idempotencyKey` if it needs per-event dedup beyond Inngest's transport-level dedup.

## Idempotency

Each event type derives an `idempotency_key` (or `null` for events where multiple identical occurrences are valid). A partial unique index on `(tenant_id, event_type, idempotency_key) WHERE idempotency_key IS NOT NULL` enforces dedup. The writer uses `INSERT ... ON CONFLICT DO NOTHING` — a BA retry won't double-publish.

| Event | `idempotency_key` |
|---|---|
| `guest.signed_up` | `userId` |
| `guest.signed_in` | `sessionId` |
| `cart.item_added` | `null` (distinct adds are distinct events) |
| `order_intent.placed` | `orderIntentId` |
| `order_intent.cancelled` | `${orderIntentId}:cancelled` |
| `payment.captured` | `externalId` (Stripe PaymentIntent id, `pi_…`) |
| `payment.refunded` | `externalId` (Stripe Refund id, `re_…`) |

## Dispatcher

`outboxDispatcher` is an Inngest cron function (`*/5 * * * *` by default, overridable via `OUTBOX_DISPATCH_CRON`). Three phases:

1. **Claim** — `SELECT ... FOR UPDATE SKIP LOCKED LIMIT 100` (no UPDATE yet).
2. **Publish** — `step.sendEvent` per row with stable `id: outbox:<row.id>` for Inngest-side dedup on retry.
3. **Mark** — single batch `UPDATE event_outbox SET published_at = now() WHERE id IN (...)`.

If the dispatcher crashes mid-loop between phase 2 and 3, the next run re-claims the same rows and re-publishes; Inngest dedups via the stable event id. **Publish-then-mark is the correct outbox shape** — mark-then-publish would silently lose events on dispatcher crash.

## `_meta` on published events

The dispatcher enriches each published event's payload with a `_meta` block:

```ts
{
  ...payload,
  _meta: {
    outboxId, eventVersion, occurredAt,
    tenantId, actorType, actorId,
    idempotencyKey, correlationId, causationId,
  },
}
```

Consumers access `event.data._meta.idempotencyKey` for per-event dedup beyond Inngest's transport-level dedup. The Zod schema (`baseEvent`) defines `_meta` as optional so the same schema covers both write-path (no `_meta`) and consumer-path (with `_meta`) parsing.

## Out of scope (deferred)

- Per-aggregate event sourcing (no read-model derivation).
- Postgres `pg_notify` dispatcher (poll-based is fine at v1 volume).
- Warehouse sync / CDC.
- Migrating pre-existing transactional-email events (`email.otp.requested` etc.) from direct `inngest.send()` to the outbox — they're already durable via Inngest's own retry semantics.
