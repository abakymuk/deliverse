/**
 * Domain event schemas — single source of truth for the shape of every
 * outbox-mediated event the workspace emits.
 *
 * Each event is a Zod object so the writer re-validates at the boundary;
 * the inferred TypeScript types are what producers `satisfies`-check against
 * at the `appendEvent(tx, ...)` call site, and what consumers `parse()`
 * against when reading dispatched events.
 *
 * Naming convention: dot-notation, `<aggregate>.<action>`. Matches @rp/emails.
 *
 * Versioning rules (canonical — see packages/events/README.md):
 *   - Additive optional fields → stay on `event_version=1`.
 *   - Breaking changes (removed/renamed fields, semantic shifts) → bump.
 *   - Consumers tolerate unknown optional fields by default.
 *
 * `_meta` is OPTIONAL on baseEvent because writers omit it; the dispatcher
 * populates it when publishing so consumers can recover outbox metadata
 * (idempotencyKey, outboxId, etc.). Default Zod `.strip()` would otherwise
 * discard `_meta` when a consumer calls `domainEvent.parse(event.data)`.
 */

import { z } from 'zod';

// ── Common shapes ─────────────────────────────────────────────────────────

const actorType = z.enum([
  'tenant_end_user',
  'platform_user',
  'service_account',
  'agent',
  'system',
]);

/**
 * authMethod includes 'unknown' for v1 — the adapter layer that emits
 * guest.signed_up / guest.signed_in doesn't have clean access to the
 * originating method (BA route context isn't on the call stack).
 *
 * Follow-up: thread real method from BA route handlers via
 * queueAfterTransactionHook's hook payload when BA's route context
 * IS on the call stack.
 */
const authMethod = z.enum(['otp', 'password', 'oauth_google', 'unknown']);

const meta = z.object({
  outboxId: z.string().uuid(),
  eventVersion: z.number().int(),
  occurredAt: z.string().datetime(),
  tenantId: z.string().uuid(),
  actorType,
  actorId: z.string().uuid().nullable(),
  idempotencyKey: z.string().nullable(),
  correlationId: z.string().uuid().nullable(),
  causationId: z.string().uuid().nullable(),
});

const baseEvent = z.object({
  tenantId: z.string().uuid(),
  occurredAt: z.string().datetime(),
  actorType, // required
  actorId: z.string().uuid().nullable(),
  correlationId: z.string().uuid().nullable().optional(),
  causationId: z.string().uuid().nullable().optional(),
  // _meta is populated by the dispatcher when publishing; writers omit it.
  _meta: meta.optional(),
});

// ── guest.signed_up ───────────────────────────────────────────────────────

export const guestSignedUp = z.object({
  name: z.literal('guest.signed_up'),
  data: baseEvent.extend({
    userId: z.string().uuid(),
    email: z.string().email(),
    method: authMethod,
    storefrontId: z.string().uuid(),
    brandId: z.string().uuid().nullable(),
  }),
});

// ── guest.signed_in ───────────────────────────────────────────────────────

export const guestSignedIn = z.object({
  name: z.literal('guest.signed_in'),
  data: baseEvent.extend({
    userId: z.string().uuid(),
    sessionId: z.string().uuid(),
    method: authMethod,
    storefrontId: z.string().uuid(),
    brandId: z.string().uuid().nullable(),
  }),
});

// ── cart.item_added ───────────────────────────────────────────────────────

export const cartItemAdded = z.object({
  name: z.literal('cart.item_added'),
  data: baseEvent.extend({
    cartId: z.string().uuid(),
    cartItemId: z.string().uuid(),
    brandId: z.string().uuid(),
    menuItemId: z.string().uuid(),
    quantity: z.number().int().positive(),
    unitPriceCents: z.number().int().nonnegative(),
    locationId: z.string().uuid(),
  }),
});

// ── order.placed ──────────────────────────────────────────────────────────
//
// Will be renamed to `order_intent.placed` in DEL-32 / X1 (Order Intent split).
// At rename time: producer emits BOTH names for one minor-version window
// with `event_version` bumped on the new name. Consumers migrate. Old name
// removed in the following release.

export const orderPlaced = z.object({
  name: z.literal('order.placed'),
  data: baseEvent.extend({
    orderId: z.string().uuid(),
    cartId: z.string().uuid().nullable(),
    locationId: z.string().uuid(),
    fulfillmentType: z.enum(['pickup', 'delivery']),
    totalCents: z.number().int().nonnegative(),
    subtotalCents: z.number().int().nonnegative(),
    /** Distinct brands present across line items — for food-hall analytics. */
    brandIds: z.array(z.string().uuid()),
    lineItemCount: z.number().int().positive(),
  }),
});

// ── order.cancelled ───────────────────────────────────────────────────────
//
// Schema-only stub for DEL-29 — no emission site exists yet. Added so a
// future cancel flow can use the event without a schema PR. Same DEL-32
// rename treatment as order.placed.

export const orderCancelled = z.object({
  name: z.literal('order.cancelled'),
  data: baseEvent.extend({
    orderId: z.string().uuid(),
    reason: z.string().max(500).nullable(),
  }),
});

// ── Union of all domain events ────────────────────────────────────────────

export const domainEvent = z.discriminatedUnion('name', [
  guestSignedUp,
  guestSignedIn,
  cartItemAdded,
  orderPlaced,
  orderCancelled,
]);

export type DomainEvent = z.infer<typeof domainEvent>;
export type EventName = DomainEvent['name'];
export type EventMeta = z.infer<typeof meta>;
