/**
 * @rp/events — domain event substrate.
 *
 * Public API surface:
 *   - Zod schemas + types:   @rp/events/schema, @rp/events/types
 *   - Writer:                @rp/events/writer
 *   - Inngest functions:     @rp/events/inngest
 *
 * This barrel file re-exports the most commonly needed names so simple
 * call sites can `import { appendEvent, type DomainEvent } from '@rp/events'`.
 */

export {
  cartItemAdded,
  domainEvent,
  guestSignedIn,
  guestSignedUp,
  orderCancelled,
  orderPlaced,
} from './schema';

export type { DomainEvent, EventMeta, EventName } from './schema';

export type {
  CartItemAdded,
  CartItemAddedData,
  EventDataMap,
  GuestSignedIn,
  GuestSignedInData,
  GuestSignedUp,
  GuestSignedUpData,
  OrderCancelled,
  OrderCancelledData,
  OrderPlaced,
  OrderPlacedData,
} from './types';

export { appendEvent, appendEventAfterCommit } from './writer';
