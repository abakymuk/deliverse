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
  orderCancelled,
  orderPlaced,
} from './schema';

export type { DomainEvent, EventName, EventMeta } from './schema';

// Per-event extracted types — useful for consumers that handle one event type.
export type GuestSignedUp = z.infer<typeof guestSignedUp>;
export type GuestSignedIn = z.infer<typeof guestSignedIn>;
export type CartItemAdded = z.infer<typeof cartItemAdded>;
export type OrderPlaced = z.infer<typeof orderPlaced>;
export type OrderCancelled = z.infer<typeof orderCancelled>;

// Per-event data-only types — the payload shape stamped into event_outbox.payload.
export type GuestSignedUpData = GuestSignedUp['data'];
export type GuestSignedInData = GuestSignedIn['data'];
export type CartItemAddedData = CartItemAdded['data'];
export type OrderPlacedData = OrderPlaced['data'];
export type OrderCancelledData = OrderCancelled['data'];

/**
 * Map of event name → data type. Useful for consumer-side narrowing:
 *
 *   function handle<N extends EventName>(name: N, data: EventDataMap[N]) { ... }
 */
export type EventDataMap = {
  'guest.signed_up': GuestSignedUpData;
  'guest.signed_in': GuestSignedInData;
  'cart.item_added': CartItemAddedData;
  'order.placed': OrderPlacedData;
  'order.cancelled': OrderCancelledData;
};

// Compile-time exhaustiveness guard — if a new event is added to the
// discriminatedUnion but not to EventDataMap, TS fails here.
type _ExhaustiveCheck = z.infer<typeof domainEvent>['name'] extends keyof EventDataMap
  ? true
  : 'EventDataMap is missing keys from domainEvent';
const _exhaustive: _ExhaustiveCheck = true;
void _exhaustive;
