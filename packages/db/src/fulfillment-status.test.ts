import { describe, expect, it } from 'vitest';
import {
  FULFILLMENT_STATUSES,
  isTerminalFulfillmentStatus,
  isValidFulfillmentTransition,
  type FulfillmentStatus,
} from './fulfillment-status';

// DEL-32 / X1. Dead-but-tested until X6 (KDS) drives the transitions — locks
// the fulfillment state-machine contract now.
describe('fulfillment status transitions', () => {
  const valid: Array<[FulfillmentStatus, FulfillmentStatus]> = [
    ['queued', 'preparing'],
    ['queued', 'cancelled'],
    ['preparing', 'ready'],
    ['preparing', 'cancelled'],
    ['ready', 'completed'],
    ['ready', 'cancelled'],
  ];

  it.each(valid)('allows %s → %s', (from, to) => {
    expect(isValidFulfillmentTransition(from, to)).toBe(true);
  });

  it('matches the allowed map for every (from, to) pair and rejects the rest', () => {
    for (const from of FULFILLMENT_STATUSES) {
      for (const to of FULFILLMENT_STATUSES) {
        const allowed = valid.some(([f, t]) => f === from && t === to);
        expect(isValidFulfillmentTransition(from, to)).toBe(allowed);
      }
    }
  });

  it('rejects self-transitions', () => {
    for (const s of FULFILLMENT_STATUSES) {
      expect(isValidFulfillmentTransition(s, s)).toBe(false);
    }
  });

  it('treats completed and cancelled as terminal, others non-terminal', () => {
    expect(isTerminalFulfillmentStatus('completed')).toBe(true);
    expect(isTerminalFulfillmentStatus('cancelled')).toBe(true);
    expect(isTerminalFulfillmentStatus('queued')).toBe(false);
    expect(isTerminalFulfillmentStatus('preparing')).toBe(false);
    expect(isTerminalFulfillmentStatus('ready')).toBe(false);
  });
});
