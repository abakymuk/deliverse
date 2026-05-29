/**
 * handlePaymentIntentSucceeded integration test (DEL-35 / X4 step 3).
 *
 * Requires DATABASE_URL:
 *   doppler run --config dev -- pnpm --filter @rp/payments test
 * Skipped otherwise — @rp/db (and the @rp/events writer the handler now imports)
 * throw at module-init without it, so both are loaded via DYNAMIC import inside
 * the gated block. PermanentWebhookError is a client-free static import; the
 * `stripe` import is type-only (erased at runtime).
 *
 * Proves:
 *   1. a succeeded PaymentIntent → exactly one `payments` row (status=captured,
 *      amount = amount_received) + exactly one `payment.captured` outbox row.
 *   2. a REPLAYED webhook (same pi_) inserts no second row and emits no second
 *      event — UNIQUE(provider, external_id) + emit-only-on-insert.
 *   3. missing/invalid metadata → PermanentWebhookError (route ACKs 200 + logs).
 */

import { randomUUID } from 'node:crypto';
import type Stripe from 'stripe';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PermanentWebhookError } from '../src/errors';

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
const PI_ID = `pi_test_del35_${randomUUID().slice(0, 8)}`;

// Minimal Stripe.PaymentIntent — only the fields the handler reads.
function makePaymentIntent(args: {
  id: string;
  amountReceived: number;
  currency: string;
  metadata?: Record<string, string>;
  applicationFeeAmount?: number | null;
}): Stripe.PaymentIntent {
  return {
    id: args.id,
    object: 'payment_intent',
    status: 'succeeded',
    created: 1780000000,
    amount: args.amountReceived,
    amount_received: args.amountReceived,
    currency: args.currency,
    application_fee_amount: args.applicationFeeAmount ?? null,
    metadata: args.metadata ?? {},
  } as Stripe.PaymentIntent;
}

describe.skipIf(!HAS_DB)('handlePaymentIntentSucceeded', () => {
  beforeAll(async () => {
    dbModule = await import('@rp/db');
    schemaModule = await import('@rp/db/schema');
    handlersModule = await import('../src/handlers');

    const { db } = dbModule;
    const { tenants, locations, orderIntents } = schemaModule;

    tenantId = randomUUID();
    locationId = randomUUID();
    orderIntentId = randomUUID();

    await db.insert(tenants).values({
      id: tenantId,
      slug: `pay-cap-${tenantId.slice(0, 8)}`,
      name: 'Capture Test Tenant',
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
  });

  afterAll(async () => {
    if (!tenantId) return;
    const { eq } = await import('drizzle-orm');
    // payments / order_intents / locations all cascade from tenant.
    await dbModule.db
      .delete(schemaModule.tenants)
      .where(eq(schemaModule.tenants.id, tenantId));
  });

  it('captures once and emits payment.captured once — idempotent on replay', async () => {
    const { db } = dbModule;
    const { payments, eventOutbox } = schemaModule;
    const { and, eq } = await import('drizzle-orm');

    const pi = makePaymentIntent({
      id: PI_ID,
      amountReceived: 1000,
      currency: 'usd',
      applicationFeeAmount: 100,
      metadata: { tenant_id: tenantId, order_intent_id: orderIntentId },
    });

    // First delivery, then a replay of the SAME PaymentIntent.
    await db.transaction((tx) => handlersModule.handlePaymentIntentSucceeded(tx, pi));
    await db.transaction((tx) => handlersModule.handlePaymentIntentSucceeded(tx, pi));

    const rows = await db
      .select({ status: payments.status, amount: payments.amountCents, fee: payments.applicationFeeCents })
      .from(payments)
      .where(and(eq(payments.provider, 'stripe'), eq(payments.externalId, PI_ID)));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('captured');
    expect(rows[0]?.amount).toBe(1000);
    expect(rows[0]?.fee).toBe(100);

    const events = await db
      .select({ id: eventOutbox.id })
      .from(eventOutbox)
      .where(
        and(
          eq(eventOutbox.tenantId, tenantId),
          eq(eventOutbox.eventType, 'payment.captured'),
          eq(eventOutbox.idempotencyKey, PI_ID),
        ),
      );
    expect(events).toHaveLength(1);
  });

  it('throws PermanentWebhookError when metadata is missing', async () => {
    const { db } = dbModule;
    const pi = makePaymentIntent({
      id: `pi_no_meta_${randomUUID().slice(0, 8)}`,
      amountReceived: 500,
      currency: 'usd',
    });
    await expect(
      db.transaction((tx) => handlersModule.handlePaymentIntentSucceeded(tx, pi)),
    ).rejects.toBeInstanceOf(PermanentWebhookError);
  });
});
