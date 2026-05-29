/**
 * Fulfillment status state machine (DEL-32 / X1).
 *
 * Client-free, dependency-free module (mirrors ./modifier-snapshot.ts) so it
 * can be imported by apps, tests, and future KDS code (X6) without pulling in
 * the Drizzle client. The pg enum `fulfillmentStatusEnum` in ./schema.ts must
 * stay in sync with FULFILLMENT_STATUSES below.
 *
 * The old flat order_status enum split into TWO machines:
 *   - intent status (placed → cancelled) lives on order_intents;
 *   - fulfillment status (below) lives per-brand on order_fulfillments and is
 *     driven by the KDS (X6). This module owns the fulfillment transitions.
 *
 * v1 has no caller that mutates fulfillment status (KDS is X6) — the validator
 * is intentionally dead-but-tested so the transition contract is locked now.
 */

export const FULFILLMENT_STATUSES = [
  'queued',
  'preparing',
  'ready',
  'completed',
  'cancelled',
] as const;

export type FulfillmentStatus = (typeof FULFILLMENT_STATUSES)[number];

/**
 * Allowed transitions. Cancel is permitted from any non-terminal state;
 * `completed` and `cancelled` are terminal (no outgoing transitions).
 */
const TRANSITIONS: Record<FulfillmentStatus, readonly FulfillmentStatus[]> = {
  queued: ['preparing', 'cancelled'],
  preparing: ['ready', 'cancelled'],
  ready: ['completed', 'cancelled'],
  completed: [],
  cancelled: [],
};

/** True iff `to` is a legal next status from `from`. */
export function isValidFulfillmentTransition(
  from: FulfillmentStatus,
  to: FulfillmentStatus,
): boolean {
  return TRANSITIONS[from].includes(to);
}

/** Terminal states have no outgoing transitions. */
export function isTerminalFulfillmentStatus(status: FulfillmentStatus): boolean {
  return TRANSITIONS[status].length === 0;
}
