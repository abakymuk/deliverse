/**
 * Outbox writer — the only sanctioned path for landing a domain event row.
 *
 * Two entry points:
 *   - appendEvent(tx, event)         — caller owns the tx (cart/checkout actions).
 *   - appendEventAfterCommit(event)  — caller has no tx (BA queueAfterTransactionHook
 *                                       callbacks). Wraps appendEvent in a small
 *                                       single-INSERT tx of its own.
 *
 * Both:
 *   - Validate the input via the @rp/events Zod schema. Validation failure throws,
 *     which in the in-tx path rolls back the caller's mutation.
 *   - Derive aggregate_type / aggregate_id / idempotency_key per event_type.
 *   - INSERT ... ON CONFLICT DO NOTHING against
 *     (tenant_id, event_type, idempotency_key) WHERE idempotency_key IS NOT NULL.
 *     A retried BA flow won't double-publish.
 *
 * FUTURE OPTIMIZATION (not v1): appendEventAfterCommit opens a small tx per hook.
 * At sustained high volume a per-request collector could batch multiple hooks
 * into one tx. Don't optimize now — at hobby/early volume the ~1 round-trip
 * overhead is noise.
 */

import { db, type Transaction } from '@rp/db';
import { eventOutbox } from '@rp/db/schema';
import { sql } from 'drizzle-orm';
import { domainEvent, type DomainEvent } from './schema';

/** aggregate_type + aggregate_id derivation per event_type. */
function aggregate(event: DomainEvent): { aggregateType: string; aggregateId: string } {
  switch (event.name) {
    case 'guest.signed_up':
    case 'guest.signed_in':
      return { aggregateType: 'guest', aggregateId: event.data.userId };
    case 'cart.item_added':
      return { aggregateType: 'cart', aggregateId: event.data.cartId };
    case 'order.placed':
    case 'order.cancelled':
      return { aggregateType: 'order', aggregateId: event.data.orderId };
  }
}

/**
 * Idempotency key per event_type — must be unique per (tenant_id, event_type).
 * `null` means "no dedup" — multiple occurrences are valid distinct events
 * (e.g., adding the same menu item to a cart twice).
 */
function idempotencyKey(event: DomainEvent): string | null {
  switch (event.name) {
    case 'guest.signed_up':
      return event.data.userId;
    case 'guest.signed_in':
      return event.data.sessionId;
    case 'cart.item_added':
      return null;
    case 'order.placed':
      return event.data.orderId;
    case 'order.cancelled':
      return `${event.data.orderId}:cancelled`;
  }
}

/**
 * Append a domain event row to event_outbox using the supplied tx.
 * The mutation that emitted this event MUST be in the same tx, so a rollback
 * tears both rows down together.
 *
 * Throws on Zod validation failure — bubbles up into the caller's tx and
 * rolls back the mutation.
 */
export async function appendEvent(tx: Transaction, event: DomainEvent): Promise<void> {
  const parsed = domainEvent.parse(event);
  const { aggregateType, aggregateId } = aggregate(parsed);

  await tx
    .insert(eventOutbox)
    .values({
      tenantId: parsed.data.tenantId,
      aggregateType,
      aggregateId,
      eventType: parsed.name,
      eventVersion: 1,
      payload: parsed.data,
      actorType: parsed.data.actorType,
      actorId: parsed.data.actorId,
      idempotencyKey: idempotencyKey(parsed),
      correlationId: parsed.data.correlationId ?? null,
      causationId: parsed.data.causationId ?? null,
      occurredAt: new Date(parsed.data.occurredAt),
    })
    .onConflictDoNothing({
      // Matches the partial unique index event_outbox_idempotency_unique.
      // The `where` predicate is REQUIRED — Postgres won't infer a partial
      // unique index for ON CONFLICT without an exact-matching predicate
      // (error 42P10 infer_arbiter_indexes otherwise). The partial index
      // only covers rows with idempotency_key IS NOT NULL, so null-key
      // inserts naturally fall through this clause without conflicting.
      target: [eventOutbox.tenantId, eventOutbox.eventType, eventOutbox.idempotencyKey],
      where: sql`${eventOutbox.idempotencyKey} IS NOT NULL`,
    });
}

/**
 * Append a domain event row in its own small transaction.
 *
 * Use from contexts where there's no Drizzle tx in scope — specifically BA's
 * queueAfterTransactionHook callbacks, where the BA tx has already committed
 * by the time the hook runs.
 *
 * CRITICAL caller responsibility: wrap the call in try/catch and structured-log
 * any failure. The BA tx already committed → the user-facing op succeeded.
 * Letting this throw would trash the user's 200 response with a 500 for a
 * downstream durability gap they didn't cause.
 */
export async function appendEventAfterCommit(event: DomainEvent): Promise<void> {
  await db.transaction((tx) => appendEvent(tx, event));
}
