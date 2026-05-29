/**
 * Outbox transactional-atomicity integration tests.
 *
 * Requires DATABASE_URL (use `doppler run --config dev -- pnpm --filter @rp/events test`).
 * Skipped otherwise — keeps `pnpm typecheck` + the unit tests fast on machines
 * without doppler.
 *
 * What this proves:
 *   1. appendEvent + cart_items insert in the same tx → both commit together.
 *   2. throw mid-tx → both rows roll back.
 *   3. Two appendEvent calls with the same (tenant_id, event_type, idempotency_key)
 *      collapse to one row via the partial unique index + onConflictDoNothing.
 *
 * This is the v1 atomicity smoke; the e2e Playwright test (apps/storefront/tests/e2e)
 * is the canonical end-to-end validation.
 */

import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Dynamic imports of @rp/db (and the writer that imports it) so vitest can
// load this file without DATABASE_URL. @rp/db throws at module-init time
// if DATABASE_URL is unset; with static imports, describe.skipIf can't help
// because the import runs before the skip is evaluated.
const HAS_DB = !!process.env.DATABASE_URL;

type DbModule = typeof import('@rp/db');
type SchemaModule = typeof import('@rp/db/schema');
type WriterModule = typeof import('../src/writer');

let dbModule: DbModule;
let schemaModule: SchemaModule;
let writerModule: WriterModule;

// Fixtures created in beforeAll, torn down in afterAll. We own the entire
// lifecycle to avoid coupling to seed.ts state.
let tenantId: string;
let locationId: string;
let brandId: string;
let menuId: string;
let menuItemId: string;
let userId: string;
let cartId: string;

describe.skipIf(!HAS_DB)('outbox transactional integrity', () => {
  beforeAll(async () => {
    dbModule = await import('@rp/db');
    schemaModule = await import('@rp/db/schema');
    writerModule = await import('../src/writer');

    const { db } = dbModule;
    const {
      tenants,
      locations,
      brands,
      menus,
      menuItems,
      tenantEndUsers,
      carts,
    } = schemaModule;

    tenantId = randomUUID();
    locationId = randomUUID();
    brandId = randomUUID();
    menuId = randomUUID();
    menuItemId = randomUUID();
    userId = randomUUID();
    cartId = randomUUID();

    await db.insert(tenants).values({
      id: tenantId,
      slug: `outbox-test-${tenantId.slice(0, 8)}`,
      name: 'Outbox Test Tenant',
    });
    await db.insert(locations).values({
      id: locationId,
      tenantId,
      name: 'Outbox Test Location',
      addressLine1: '1 Test St',
      city: 'Testville',
      state: 'CA',
      postalCode: '00000',
      country: 'US',
    });
    await db.insert(brands).values({
      id: brandId,
      tenantId,
      slug: `outbox-test-brand-${brandId.slice(0, 8)}`,
      name: 'Outbox Test Brand',
    });
    await db.insert(menus).values({ id: menuId, brandId, name: 'Default Menu' });
    await db.insert(menuItems).values({
      id: menuItemId,
      menuId,
      name: 'Test Item',
      priceCents: 999,
    });
    await db.insert(tenantEndUsers).values({
      id: userId,
      tenantId,
      email: `outbox-test-${userId.slice(0, 8)}@example.com`,
      name: 'Outbox Test User',
    });
    await db.insert(carts).values({
      id: cartId,
      tenantId,
      locationId,
      tenantEndUserId: userId,
      status: 'active',
      fulfillmentType: 'pickup',
    });
  });

  afterAll(async () => {
    // Cascade delete via tenants FK chain wipes everything.
    if (!dbModule || !schemaModule || !tenantId) return;
    const { db } = dbModule;
    const { tenants } = schemaModule;
    await db.delete(tenants).where(eq(tenants.id, tenantId));
  });

  function cartItemFixture(cartItemId: string) {
    return {
      cartId,
      brandId,
      menuItemId,
      quantity: 1,
      unitPriceCents: 999,
      // Cart_item PK is auto-generated; pass id only when we need to refer back.
      // We do, so the test can assert presence/absence by id.
      id: cartItemId,
    };
  }

  function eventFixture(cartItemId: string) {
    return {
      name: 'cart.item_added' as const,
      data: {
        tenantId,
        occurredAt: new Date().toISOString(),
        actorType: 'tenant_end_user' as const,
        actorId: userId,
        cartId,
        cartItemId,
        brandId,
        menuItemId,
        quantity: 1,
        unitPriceCents: 999,
        locationId,
      },
    };
  }

  it('commits cart_item + event_outbox row together', async () => {
    const { db } = dbModule;
    const { cartItems, eventOutbox } = schemaModule;
    const { appendEvent } = writerModule;

    const cartItemId = randomUUID();
    await db.transaction(async (tx) => {
      await tx.insert(cartItems).values(cartItemFixture(cartItemId));
      await appendEvent(tx, eventFixture(cartItemId));
    });

    const [item] = await db
      .select({ id: cartItems.id })
      .from(cartItems)
      .where(eq(cartItems.id, cartItemId));
    expect(item).toBeDefined();

    const events = await db
      .select({ id: eventOutbox.id, eventType: eventOutbox.eventType })
      .from(eventOutbox)
      .where(
        and(
          eq(eventOutbox.tenantId, tenantId),
          eq(eventOutbox.eventType, 'cart.item_added'),
          eq(eventOutbox.aggregateId, cartId),
        ),
      );
    expect(events.some((e) => e.eventType === 'cart.item_added')).toBe(true);
  });

  it('rolls back cart_item + event_outbox row together when tx throws', async () => {
    const { db } = dbModule;
    const { cartItems, eventOutbox } = schemaModule;
    const { appendEvent } = writerModule;

    const cartItemId = randomUUID();
    await expect(
      db.transaction(async (tx) => {
        await tx.insert(cartItems).values(cartItemFixture(cartItemId));
        await appendEvent(tx, eventFixture(cartItemId));
        throw new Error('rollback trigger');
      }),
    ).rejects.toThrow('rollback trigger');

    const [item] = await db
      .select({ id: cartItems.id })
      .from(cartItems)
      .where(eq(cartItems.id, cartItemId));
    expect(item).toBeUndefined();

    // The outbox row inserted in the rolled-back tx must NOT be present.
    // Because cart.item_added has idempotency_key=null we can't filter on
    // aggregate alone; we check by scanning tenant's events and verifying
    // no row references this cartItemId in its payload.
    const events = await db
      .select({ id: eventOutbox.id, payload: eventOutbox.payload })
      .from(eventOutbox)
      .where(eq(eventOutbox.tenantId, tenantId));
    expect(
      events.find(
        (e) =>
          (e.payload as { cartItemId?: string } | null)?.cartItemId === cartItemId,
      ),
    ).toBeUndefined();
  });

  it('deduplicates events with the same idempotency_key', async () => {
    const { db } = dbModule;
    const { eventOutbox } = schemaModule;
    const { appendEvent } = writerModule;

    // order_intent.placed uses orderIntentId as idempotency_key. Two
    // appendEvent calls with the same id should collapse to one row via the
    // partial unique index + onConflictDoNothing in writer.
    const orderIntentId = randomUUID();
    const orderEvent = {
      name: 'order_intent.placed' as const,
      data: {
        tenantId,
        occurredAt: new Date().toISOString(),
        actorType: 'tenant_end_user' as const,
        actorId: userId,
        orderIntentId,
        cartId,
        locationId,
        totalCents: 999,
        subtotalCents: 999,
        brandIds: [brandId],
        lineItemCount: 1,
      },
    };

    await db.transaction(async (tx) => {
      await appendEvent(tx, orderEvent);
      await appendEvent(tx, orderEvent); // duplicate — no-op via ON CONFLICT DO NOTHING
    });

    const events = await db
      .select({ id: eventOutbox.id })
      .from(eventOutbox)
      .where(
        and(
          eq(eventOutbox.tenantId, tenantId),
          eq(eventOutbox.eventType, 'order_intent.placed'),
          eq(eventOutbox.aggregateId, orderIntentId),
        ),
      );
    expect(events).toHaveLength(1);
  });
});
