import { expect, test } from '@playwright/test';
import { db } from '@rp/db';
import {
  brands,
  cartItems,
  carts,
  orderLineItems,
  orders,
  tenantEndUserSessions,
  tenantEndUsers,
  tenants,
} from '@rp/db/schema';
import { and, eq, isNull } from 'drizzle-orm';

/**
 * DEL-26 — Mode 1 (single-brand tenant) end-to-end coverage on
 * `solo-cafe-test.localhost:3001`.
 *
 * AC#2 of DEL-26. HTTP-driven (no browser) — matches the
 * `storefront-tenant-scoping.spec.ts` pattern for AC-coverage e2es. The
 * browser-driven mode-3 flow lives in `food-hall.spec.ts`.
 *
 * What this spec proves about Mode 1 (the degenerate single-brand case
 * per ADR-0012):
 *   1. Home GET on a single-brand storefront returns 200 with brand name
 *      and is NOT a food-hall directory.
 *   2. Signup writes the user row tagged with the single tenant_id and
 *      writes a session with `currentBrandId` = the single brand UUID
 *      (NOT NULL — this is a `type='brand'` storefront).
 *   3. `/signup` page does NOT render the DEL-7 sibling-brand disclosure.
 *      Mode 1 by definition has no siblings to disclose.
 *   4. DB-layer: cart with one brand → order with one brand on line items.
 *      Mirrors `commerce-schema.spec.ts` AC#8 shape, narrowed to a single
 *      brand (proves ADR-0012's "Mode 1 is the degenerate Mode N case").
 *
 * Fixture: `solo-cafe-test` (gated on `SEED_TEST_FIXTURES=1`), seeded by
 * `packages/db/src/seed.ts`. `beforeAll` resolves the fixture and throws
 * loudly if the flag wasn't set.
 *
 * Spec: docs/specs/food-hall-test-matrix.md.
 */

const STOREFRONT_PORT = 3001;
const SOLO_TENANT_SLUG = 'solo-cafe-test';
const SOLO_BRAND_SLUG = 'solo-cafe-test';
// Deterministic UUIDs from packages/db/src/seed.ts (DEL-26 block).
const SOLO_LOCATION_ID = '00000000-0000-4000-8000-000000000080';
const SOLO_ITEM_ESPRESSO_ID = '00000000-0000-4000-8000-000000000082';

const soloOrigin = `http://${SOLO_TENANT_SLUG}.localhost:${STOREFRONT_PORT}`;

function urlFor(slug: string, path: string): string {
  return `http://${slug}.localhost:${STOREFRONT_PORT}${path}`;
}

function nonce(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// Serial: tests share fixture lookup + cleanup tracking across tests 2 + 4.
// Parallel workers would race afterAll teardown (matches the
// storefront-tenant-scoping.spec.ts rationale).
test.describe
  .serial('DEL-26 — Mode 1 (single-brand) on solo-cafe-test', () => {
    let soloTenantId: string;
    let soloBrandId: string;
    let signupUserId: string | undefined; // test 2
    let dbUserId: string | undefined; // test 4
    let orderId: string | undefined; // test 4

    test.beforeAll(async () => {
      const [tenantRow] = await db
        .select({ id: tenants.id })
        .from(tenants)
        .where(and(eq(tenants.slug, SOLO_TENANT_SLUG), isNull(tenants.deletedAt)))
        .limit(1);
      if (!tenantRow) {
        throw new Error(
          'solo-cafe-test tenant not seeded — run `SEED_TEST_FIXTURES=1 pnpm db:seed`. See docs/specs/food-hall-test-matrix.md § "Edge Cases".',
        );
      }
      soloTenantId = tenantRow.id;

      const [brandRow] = await db
        .select({ id: brands.id })
        .from(brands)
        .where(
          and(
            eq(brands.tenantId, soloTenantId),
            eq(brands.slug, SOLO_BRAND_SLUG),
            isNull(brands.deletedAt),
          ),
        )
        .limit(1);
      if (!brandRow) {
        throw new Error(
          'solo-cafe brand not seeded — run `SEED_TEST_FIXTURES=1 pnpm db:seed`.',
        );
      }
      soloBrandId = brandRow.id;
    });

    test.afterAll(async () => {
      // Order before user — `orders.tenant_end_user_id SET NULL` policy
      // means the row stays after user delete but is no longer findable
      // by user id (matches food-hall.spec.ts cleanup pattern).
      if (orderId) await db.delete(orders).where(eq(orders.id, orderId));
      if (signupUserId)
        await db.delete(tenantEndUsers).where(eq(tenantEndUsers.id, signupUserId));
      if (dbUserId)
        await db.delete(tenantEndUsers).where(eq(tenantEndUsers.id, dbUserId));
    });

    test('1. brand home renders single-brand storefront (not a food-hall directory)', async ({
      request,
    }) => {
      const res = await request.get(urlFor(SOLO_TENANT_SLUG, '/'));
      expect(res.status()).toBe(200);
      const body = await res.text();
      // Positive: brand name is in the body (brand-host shell renders the brand).
      expect(body).toContain('Solo Cafe');
      // Negative: type='brand' storefront must NOT render the food-hall
      // directory intro copy (that's the `type='tenant'` UI).
      expect(body).not.toContain('Choose a brand to start your order');
    });

    test('2. password signup stamps tenant_id + session.currentBrandId (brand-host invariant)', async ({
      request,
    }) => {
      const email = `del26-mode1-${nonce()}@solo.test`;
      const res = await request.post(
        urlFor(SOLO_TENANT_SLUG, '/api/auth/sign-up/email'),
        {
          data: { name: 'Solo Test', email, password: 'solo-pass-12chars' },
          headers: { Origin: soloOrigin },
        },
      );
      expect(res.status(), `signup body: ${await res.text()}`).toBe(200);

      const [user] = await db
        .select({ id: tenantEndUsers.id, tenantId: tenantEndUsers.tenantId })
        .from(tenantEndUsers)
        .where(
          and(eq(tenantEndUsers.email, email), isNull(tenantEndUsers.deletedAt)),
        )
        .limit(1);
      if (!user) throw new Error(`user row not written for ${email}`);
      expect(user.tenantId).toBe(soloTenantId);
      signupUserId = user.id;

      const [session] = await db
        .select({ currentBrandId: tenantEndUserSessions.currentBrandId })
        .from(tenantEndUserSessions)
        .where(eq(tenantEndUserSessions.tenantEndUserId, user.id))
        .limit(1);
      if (!session) throw new Error('session row not written');
      // Single-brand tenant is `storefronts.type='brand'`: session.currentBrandId
      // MUST be the brand UUID (not NULL — that's the tenant-host shape from
      // DEL-22 storefront-host-resolution.spec.ts test 7).
      expect(session.currentBrandId).toBe(soloBrandId);
    });

    test('3. /signup does NOT render sibling-brand disclosure (no siblings exist)', async ({
      request,
    }) => {
      const res = await request.get(urlFor(SOLO_TENANT_SLUG, '/signup'));
      expect(res.status()).toBe(200);
      const body = await res.text();
      // DEL-7 disclosure copy patterns (see docs/specs/auth-ui.md §4). Both
      // must be absent on a single-brand tenant — there are no siblings to
      // surface, so the inline cross-brand recognition card never renders.
      expect(body).not.toContain('is part of');
      expect(body).not.toContain('Your account works at all of them');
    });

    test('4. cart with one brand → order with one brand on line item (DB-layer Mode-1 shape)', async () => {
      // Independent ephemeral user — test 2's user is a session-test
      // artifact (no cart/order). This test owns its own user so afterAll
      // cleanup is unambiguous.
      const email = `del26-mode1-db-${nonce()}@solo.test`;
      const [user] = await db
        .insert(tenantEndUsers)
        .values({
          tenantId: soloTenantId,
          email,
          name: 'Mode-1 DB Test',
          emailVerified: true,
        })
        .returning({ id: tenantEndUsers.id });
      if (!user) throw new Error('failed to insert ephemeral test user');
      dbUserId = user.id;

      // === Cart ===
      const [cart] = await db
        .insert(carts)
        .values({
          tenantId: soloTenantId,
          locationId: SOLO_LOCATION_ID,
          tenantEndUserId: user.id,
          status: 'active',
          fulfillmentType: 'pickup',
        })
        .returning({ id: carts.id });
      if (!cart) throw new Error('failed to insert cart');

      await db.insert(cartItems).values({
        cartId: cart.id,
        brandId: soloBrandId,
        menuItemId: SOLO_ITEM_ESPRESSO_ID,
        quantity: 2,
        unitPriceCents: 450,
      });

      // Assert the cart shape — one line, one brand.
      const cartLines = await db
        .select({ brandId: cartItems.brandId })
        .from(cartItems)
        .where(eq(cartItems.cartId, cart.id));
      expect(cartLines).toHaveLength(1);
      expect(cartLines[0]?.brandId).toBe(soloBrandId);

      // === Order ===
      const subtotalCents = 450 * 2; // 900
      const [order] = await db
        .insert(orders)
        .values({
          tenantId: soloTenantId,
          locationId: SOLO_LOCATION_ID,
          tenantEndUserId: user.id,
          status: 'confirmed',
          fulfillmentType: 'pickup',
          subtotalCents,
          taxCents: 0,
          feeCents: 0,
          tipCents: 0,
          totalCents: subtotalCents,
        })
        .returning({ id: orders.id });
      if (!order) throw new Error('failed to insert order');
      orderId = order.id;

      await db.insert(orderLineItems).values({
        orderId: order.id,
        brandId: soloBrandId,
        brandNameSnapshot: 'Solo Cafe',
        menuItemIdSnapshot: SOLO_ITEM_ESPRESSO_ID,
        nameSnapshot: 'House Espresso',
        quantity: 2,
        unitPriceCents: 450,
        totalCents: 900,
      });

      // === Assertions on the order line item shape ===
      const lines = await db
        .select({
          brandId: orderLineItems.brandId,
          brandNameSnapshot: orderLineItems.brandNameSnapshot,
          nameSnapshot: orderLineItems.nameSnapshot,
          quantity: orderLineItems.quantity,
          totalCents: orderLineItems.totalCents,
        })
        .from(orderLineItems)
        .where(eq(orderLineItems.orderId, order.id));
      expect(lines).toHaveLength(1);
      const [line] = lines;
      if (!line) throw new Error('unreachable — length asserted above');
      // Mode-1 invariant: brand_id on the line is the single brand UUID.
      expect(line.brandId).toBe(soloBrandId);
      expect(line.brandNameSnapshot).toBe('Solo Cafe');
      expect(line.nameSnapshot).toBe('House Espresso');
      expect(line.quantity).toBe(2);
      expect(line.totalCents).toBe(900);
    });
  });
