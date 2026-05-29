/**
 * createPaymentIntentForOrder guard tests (DEL-44).
 *
 * Requires DATABASE_URL:
 *   doppler run --config dev -- pnpm --filter @rp/payments test
 * Skipped otherwise — payment-intent.ts imports @rp/db (throws at module-init
 * without DATABASE_URL), so it's loaded via DYNAMIC import inside the gated block.
 *
 * Only the GUARD paths are exercised here: they throw BEFORE the Stripe call
 * (`getStripe()`), so no STRIPE_SECRET_KEY / network is needed. The happy path (a
 * real PaymentIntent) is covered by the storefront e2e in Stripe test mode.
 *
 * Proves:
 *   1. unknown order_intent → throws.
 *   2. tenant not charges-enabled → throws (without touching Stripe).
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const HAS_DB = !!process.env.DATABASE_URL;

type DbModule = typeof import('@rp/db');
type SchemaModule = typeof import('@rp/db/schema');
type PaymentIntentModule = typeof import('../src/payment-intent');

let dbModule: DbModule;
let schemaModule: SchemaModule;
let piModule: PaymentIntentModule;

let tenantId: string;
let locationId: string;
let orderIntentId: string;

describe.skipIf(!HAS_DB)('createPaymentIntentForOrder (guards)', () => {
  beforeAll(async () => {
    dbModule = await import('@rp/db');
    schemaModule = await import('@rp/db/schema');
    piModule = await import('../src/payment-intent');

    const { db } = dbModule;
    const { tenants, locations, orderIntents } = schemaModule;

    tenantId = randomUUID();
    locationId = randomUUID();
    orderIntentId = randomUUID();

    // Tenant deliberately NOT charges-enabled (default false, no account).
    await db.insert(tenants).values({
      id: tenantId,
      slug: `pay-pi-${tenantId.slice(0, 8)}`,
      name: 'PI Guard Test Tenant',
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
    await dbModule.db
      .delete(schemaModule.tenants)
      .where(eq(schemaModule.tenants.id, tenantId));
  });

  it('throws for an unknown order_intent', async () => {
    await expect(piModule.createPaymentIntentForOrder(randomUUID())).rejects.toThrow(/not found/);
  });

  it('throws when the tenant is not charges-enabled (before any Stripe call)', async () => {
    await expect(piModule.createPaymentIntentForOrder(orderIntentId)).rejects.toThrow(
      /not charges-enabled/,
    );
  });
});
