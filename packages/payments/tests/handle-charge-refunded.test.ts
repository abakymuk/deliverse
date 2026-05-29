/**
 * handleChargeRefunded integration test (DEL-35 / X4 step 4).
 *
 * Requires DATABASE_URL:
 *   doppler run --config dev -- pnpm --filter @rp/payments test
 * Skipped otherwise — @rp/db (and the @rp/events writer the handler imports)
 * throw at module-init without it, so both are loaded via DYNAMIC import inside
 * the gated block. The `stripe` import is type-only (erased at runtime).
 *
 * Proves:
 *   1. charge.refunded → one `refunds` row (transfer_reversed, fee recorded) +
 *      one order_modifications(kind='refund', -amount) + one `payment.refunded`
 *      outbox row; payments.status → 'refunded' on a full refund.
 *   2. a replayed webhook (same re_) creates no duplicate row / ledger / event.
 */

import { randomUUID } from 'node:crypto';
import type Stripe from 'stripe';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const HAS_DB = !!process.env.DATABASE_URL;

type DbModule = typeof import('@rp/db');
type SchemaModule = typeof import('@rp/db/schema');
type HandlersModule = typeof import('../src/handlers');

let dbModule: DbModule;
let schemaModule: SchemaModule;
let handlersModule: HandlersModule;

let tenantId: string;
let locationId: string;
let orderIntentId: string;
let paymentId: string;
const PI_ID = `pi_test_refund_${randomUUID().slice(0, 8)}`;
const RE_ID = `re_test_${randomUUID().slice(0, 8)}`;

// Minimal Stripe.Charge — only the fields handleChargeRefunded reads.
function makeCharge(args: {
  paymentIntentId: string;
  refunded: boolean;
  applicationFeeAmount: number | null;
  refunds: Array<{ id: string; amount: number; status: string }>;
}): Stripe.Charge {
  return {
    id: `ch_${randomUUID().slice(0, 8)}`,
    object: 'charge',
    payment_intent: args.paymentIntentId,
    refunded: args.refunded,
    application_fee_amount: args.applicationFeeAmount,
    refunds: {
      object: 'list',
      has_more: false,
      url: '',
      data: args.refunds.map((r) => ({
        id: r.id,
        object: 'refund',
        amount: r.amount,
        currency: 'usd',
        status: r.status,
        created: 1780000100,
        transfer_reversal: `trr_${r.id}`,
        metadata: {},
      })),
    },
  } as unknown as Stripe.Charge;
}

describe.skipIf(!HAS_DB)('handleChargeRefunded', () => {
  beforeAll(async () => {
    dbModule = await import('@rp/db');
    schemaModule = await import('@rp/db/schema');
    handlersModule = await import('../src/handlers');

    const { db } = dbModule;
    const { tenants, locations, orderIntents, payments } = schemaModule;

    tenantId = randomUUID();
    locationId = randomUUID();
    orderIntentId = randomUUID();
    paymentId = randomUUID();

    await db.insert(tenants).values({
      id: tenantId,
      slug: `pay-ref-${tenantId.slice(0, 8)}`,
      name: 'Refund Test Tenant',
    });
    await db.insert(locations).values({
      id: locationId,
      tenantId,
      name: 'Test Kitchen',
      addressLine1: '1 Test St',
      city: 'Testville',
      state: 'CA',
      postalCode: '94000',
      country: 'US',
    });
    await db.insert(orderIntents).values({
      id: orderIntentId,
      tenantId,
      locationId,
      placedByActorType: 'system',
      subtotalCents: 1000,
      totalCents: 1000,
    });
    await db.insert(payments).values({
      id: paymentId,
      tenantId,
      orderIntentId,
      provider: 'stripe',
      externalId: PI_ID,
      amountCents: 1000,
      currency: 'usd',
      applicationFeeCents: 100,
      status: 'captured',
      capturedAt: new Date(),
    });
  });

  afterAll(async () => {
    if (!tenantId) return;
    const { eq } = await import('drizzle-orm');
    await dbModule.db
      .delete(schemaModule.tenants)
      .where(eq(schemaModule.tenants.id, tenantId));
  });

  it('records refund + ledger + event and marks the payment refunded — idempotent on replay', async () => {
    const { db } = dbModule;
    const { refunds, orderModifications, payments, eventOutbox } = schemaModule;
    const { and, eq } = await import('drizzle-orm');

    const charge = makeCharge({
      paymentIntentId: PI_ID,
      refunded: true,
      applicationFeeAmount: 100,
      refunds: [{ id: RE_ID, amount: 1000, status: 'succeeded' }],
    });

    await db.transaction((tx) => handlersModule.handleChargeRefunded(tx, charge));
    await db.transaction((tx) => handlersModule.handleChargeRefunded(tx, charge)); // replay

    const refundRows = await db
      .select({
        status: refunds.status,
        transferReversed: refunds.transferReversed,
        feeRefunded: refunds.applicationFeeRefundedCents,
        modId: refunds.orderModificationId,
      })
      .from(refunds)
      .where(and(eq(refunds.provider, 'stripe'), eq(refunds.externalId, RE_ID)));
    expect(refundRows).toHaveLength(1);
    expect(refundRows[0]?.status).toBe('succeeded');
    expect(refundRows[0]?.transferReversed).toBe(true);
    expect(refundRows[0]?.feeRefunded).toBe(100);
    expect(refundRows[0]?.modId).not.toBeNull();

    const mods = await db
      .select({ kind: orderModifications.kind, delta: orderModifications.financialDeltaCents })
      .from(orderModifications)
      .where(eq(orderModifications.orderIntentId, orderIntentId));
    expect(mods).toHaveLength(1);
    expect(mods[0]?.kind).toBe('refund');
    expect(mods[0]?.delta).toBe(-1000);

    const [pay] = await db
      .select({ status: payments.status })
      .from(payments)
      .where(eq(payments.id, paymentId));
    expect(pay?.status).toBe('refunded');

    const events = await db
      .select({ id: eventOutbox.id })
      .from(eventOutbox)
      .where(
        and(eq(eventOutbox.eventType, 'payment.refunded'), eq(eventOutbox.idempotencyKey, RE_ID)),
      );
    expect(events).toHaveLength(1);
  });
});
