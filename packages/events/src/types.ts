/**
 * Inferred TypeScript types for domain events.
 *
 * Re-exports from schema.ts for convenience. Consumers import:
 *   import type { DomainEvent, EventName } from '@rp/events/types';
 *   import type { GuestSignedUp, CartItemAdded } from '@rp/events/types';
 */

import type { z } from 'zod';
import type {
  cartItemAdded,
  domainEvent,
  guestSignedIn,
  guestSignedUp,
  orderIntentCancelled,
  orderIntentPlaced,
  paymentCaptured,
  paymentRefunded,
} from './schema';

export type { DomainEvent, EventName, EventMeta } from './schema';

// Per-event extracted types — useful for consumers that handle one event type.
export type GuestSignedUp = z.infer<typeof guestSignedUp>;
export type GuestSignedIn = z.infer<typeof guestSignedIn>;
export type CartItemAdded = z.infer<typeof cartItemAdded>;
export type OrderIntentPlaced = z.infer<typeof orderIntentPlaced>;
export type OrderIntentCancelled = z.infer<typeof orderIntentCancelled>;
export type PaymentCaptured = z.infer<typeof paymentCaptured>;
export type PaymentRefunded = z.infer<typeof paymentRefunded>;

// Per-event data-only types — the payload shape stamped into event_outbox.payload.
export type GuestSignedUpData = GuestSignedUp['data'];
export type GuestSignedInData = GuestSignedIn['data'];
export type CartItemAddedData = CartItemAdded['data'];
export type OrderIntentPlacedData = OrderIntentPlaced['data'];
export type OrderIntentCancelledData = OrderIntentCancelled['data'];
export type PaymentCapturedData = PaymentCaptured['data'];
export type PaymentRefundedData = PaymentRefunded['data'];

/**
 * Map of event name → data type. Useful for consumer-side narrowing:
 *
 *   function handle<N extends EventName>(name: N, data: EventDataMap[N]) { ... }
 */
export type EventDataMap = {
  'guest.signed_up': GuestSignedUpData;
  'guest.signed_in': GuestSignedInData;
  'cart.item_added': CartItemAddedData;
  'order_intent.placed': OrderIntentPlacedData;
  'order_intent.cancelled': OrderIntentCancelledData;
  'payment.captured': PaymentCapturedData;
  'payment.refunded': PaymentRefundedData;
};

// Compile-time exhaustiveness guard — if a new event is added to the
// discriminatedUnion but not to EventDataMap, TS fails here.
type _ExhaustiveCheck = z.infer<typeof domainEvent>['name'] extends keyof EventDataMap
  ? true
  : 'EventDataMap is missing keys from domainEvent';
const _exhaustive: _ExhaustiveCheck = true;
void _exhaustive;
