import { expect, test } from '@playwright/test';
import { db } from '@rp/db';
import {
  brands,
  cartItems,
  carts,
  locations,
  menuItems,
  menus,
  orderIntentItems,
  orderIntents,
  tenantEndUsers,
  tenants,
} from '@rp/db/schema';
import { and, count, eq, isNull } from 'drizzle-orm';

/**
 * DEL-24 integration tests — commerce schema (carts span brands, orders
 * carry mixed brand_id line items).
 *
 * Two test cases:
 *   1. AC#8 mixed-brand shape — directly inserts a cart with line items
 *      from 2 brands, then an order with 2 line items + snapshots; asserts
 *      on the rows the test wrote.
 *   2. FK policy validation — creates a complete throwaway tenant tree
 *      (brand + location + menu + menu_item + end_user + cart + cart_item +
 *      order + order_line_item) and DELETEs the tenant, asserting every
 *      child row is gone with no FK error. Protects the dual-cascade-path
 *      design (`orders.tenant_end_user_id SET NULL` running concurrently
 *      with `orders.tenant_id CASCADE`).
 *
 * Drives entirely via @rp/db — no HTTP. Test inserts are isolated from the
 * SEED_TEST_FIXTURES cart fixture; this test owns its own lifecycle.
 *
 * Spec: docs/specs/commerce-schema-v1.md.
 */

const HOSPITALITY_TENANT_SLUG = 'hospitality-group';
const PIZZA_BRAND_SLUG = 'pizza-express';
const BURGER_BRAND_SLUG = 'burger-heaven';
// Deterministic UUID from seed.ts.
const DOWNTOWN_LOCATION_ID = '00000000-0000-4000-8000-000000000001';

function nonce(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function resolveTenantId(slug: string): Promise<string> {
  const [row] = await db
    .select({ id: tenants.id })
    .from(tenants)
    .where(and(eq(tenants.slug, slug), isNull(tenants.deletedAt)))
    .limit(1);
  if (!row) throw new Error(`tenant slug "${slug}" not found — seed first`);
  return row.id;
}

async function resolveBrandId(slug: string): Promise<string> {
  const [row] = await db
    .select({ id: brands.id })
    .from(brands)
    .where(and(eq(brands.slug, slug), isNull(brands.deletedAt)))
    .limit(1);
  if (!row) throw new Error(`brand slug "${slug}" not found — seed first`);
  return row.id;
}

async function resolveMenuItemId(brandId: string, name: string): Promise<string> {
  // menu_items → menu → brand chain; no direct brand_id on menu_items.
  const rows = await db
    .select({ id: menuItems.id })
    .from(menuItems)
    .innerJoin(menus, eq(menus.id, menuItems.menuId))
    .where(
      and(
        eq(menus.brandId, brandId),
        eq(menuItems.name, name),
        isNull(menuItems.deletedAt),
        isNull(menus.deletedAt),
      ),
    )
    .limit(1);
  if (!rows[0]) throw new Error(`menu_item "${name}" for brand ${brandId} not found — seed first`);
  return rows[0].id;
}

// Serial: both tests share a single afterAll cleanup with undefined-guards.
// Test 2's throwaway-tenant cleanup is independent of Test 1.
test.describe
  .serial('DEL-24 — commerce schema (carts span brands, orders carry mixed brand_id line items)', () => {
    // Test 1 (AC#8) scope:
    let tenantId: string;
    let pizzaBrandId: string;
    let burgerBrandId: string;
    let endUserId: string | undefined;
    let orderId: string | undefined;
    // cart cleanup rides on tenantEndUsers cascade (carts.tenant_end_user_id
    // ON DELETE CASCADE), so the test doesn't need to track the cart id.

    // Test 2 (FK policy) scope:
    let throwawayTenantId: string | undefined;

    test.beforeAll(async () => {
      tenantId = await resolveTenantId(HOSPITALITY_TENANT_SLUG);
      pizzaBrandId = await resolveBrandId(PIZZA_BRAND_SLUG);
      burgerBrandId = await resolveBrandId(BURGER_BRAND_SLUG);

      // Ephemeral test end-user, isolated from SEED_TEST_FIXTURES cart-test
      // user. Uses bare onConflictDoNothing() — tenant_end_users has a
      // partial-unique index on (tenant_id, email) WHERE deleted_at IS NULL
      // (matches platformUsers seed pattern at seed.ts:60).
      const email = `commerce-spec+${nonce()}@del24.local`;
      await db
        .insert(tenantEndUsers)
        .values({ tenantId, email, name: 'Commerce Spec', emailVerified: true })
        .onConflictDoNothing();

      const [user] = await db
        .select({ id: tenantEndUsers.id })
        .from(tenantEndUsers)
        .where(
          and(
            eq(tenantEndUsers.tenantId, tenantId),
            eq(tenantEndUsers.email, email),
            isNull(tenantEndUsers.deletedAt),
          ),
        )
        .limit(1);
      if (!user) throw new Error(`failed to insert / read back test end-user ${email}`);
      endUserId = user.id;
    });

    test.afterAll(async () => {
      // Guard each cleanup — if setup or a test failed mid-way, undefined IDs
      // shouldn't make teardown throw a second error and mask the original
      // failure.
      if (orderId) await db.delete(orderIntents).where(eq(orderIntents.id, orderId));
      if (endUserId) await db.delete(tenantEndUsers).where(eq(tenantEndUsers.id, endUserId));
      if (throwawayTenantId) await db.delete(tenants).where(eq(tenants.id, throwawayTenantId));
    });

    test('AC#8 — cart with line items from 2 brands → order with 2 mixed-brand line items', async () => {
      expect(endUserId, 'beforeAll setup must have run').toBeDefined();
      // Narrow endUserId from `string | undefined` to `string` for this test —
      // `expect().toBeDefined()` is a runtime-only assertion that TypeScript
      // can't see through; the throw is unreachable but keeps the type checker
      // happy without resorting to a non-null assertion.
      if (!endUserId) throw new Error('unreachable — expect.toBeDefined() asserts');

      const pizzaItemId = await resolveMenuItemId(pizzaBrandId, 'Margherita');
      const burgerItemId = await resolveMenuItemId(burgerBrandId, 'Classic Burger');

      // === 1. Cart ===
      const [cart] = await db
        .insert(carts)
        .values({
          tenantId,
          locationId: DOWNTOWN_LOCATION_ID,
          tenantEndUserId: endUserId,
          status: 'active',
          fulfillmentType: 'pickup',
        })
        .returning({ id: carts.id });
      if (!cart) throw new Error('failed to insert cart');

      // === 2. Cart items (mixed brand) ===
      await db.insert(cartItems).values([
        {
          cartId: cart.id,
          brandId: pizzaBrandId,
          menuItemId: pizzaItemId,
          quantity: 1,
          unitPriceCents: 1400,
        },
        {
          cartId: cart.id,
          brandId: burgerBrandId,
          menuItemId: burgerItemId,
          quantity: 2,
          unitPriceCents: 1200,
        },
      ]);

      // Assert cart shape: 2 line items, two distinct brands.
      const cartLines = await db
        .select({ brandId: cartItems.brandId })
        .from(cartItems)
        .where(eq(cartItems.cartId, cart.id));
      expect(cartLines).toHaveLength(2);
      const cartBrandIds = new Set(cartLines.map((r) => r.brandId));
      expect(cartBrandIds.size).toBe(2);
      expect(cartBrandIds.has(pizzaBrandId)).toBe(true);
      expect(cartBrandIds.has(burgerBrandId)).toBe(true);

      // === 3. Order intent (DEL-32 / X1) ===
      const subtotalCents = 1400 + 1200 * 2; // 3800
      const [order] = await db
        .insert(orderIntents)
        .values({
          tenantId,
          locationId: DOWNTOWN_LOCATION_ID,
          tenantEndUserId: endUserId,
          placedByActorType: 'tenant_end_user',
          placedByActorId: endUserId,
          subtotalCents,
          taxCents: 0,
          feeCents: 0,
          tipCents: 0,
          totalCents: subtotalCents,
        })
        .returning({ id: orderIntents.id });
      if (!order) throw new Error('failed to insert order intent');
      orderId = order.id;

      // === 4. Order intent items (snapshots) ===
      await db.insert(orderIntentItems).values([
        {
          orderIntentId: order.id,
          brandId: pizzaBrandId,
          brandNameSnapshot: 'Pizza Express',
          menuItemIdSnapshot: pizzaItemId,
          nameSnapshot: 'Margherita',
          quantity: 1,
          unitPriceCents: 1400,
          totalCents: 1400,
        },
        {
          orderIntentId: order.id,
          brandId: burgerBrandId,
          brandNameSnapshot: 'Burger Heaven',
          menuItemIdSnapshot: burgerItemId,
          nameSnapshot: 'Classic Burger',
          quantity: 2,
          unitPriceCents: 1200,
          totalCents: 2400,
        },
      ]);

      // === 5. Cart marked converted ===
      await db.update(carts).set({ status: 'converted' }).where(eq(carts.id, cart.id));

      // === Assertions on the rows the test wrote ===
      // Order line items: length 2, distinct brand_ids, snapshots populated.
      const orderLines = await db
        .select({
          brandId: orderIntentItems.brandId,
          brandNameSnapshot: orderIntentItems.brandNameSnapshot,
          nameSnapshot: orderIntentItems.nameSnapshot,
          quantity: orderIntentItems.quantity,
          totalCents: orderIntentItems.totalCents,
        })
        .from(orderIntentItems)
        .where(eq(orderIntentItems.orderIntentId, order.id));
      expect(orderLines).toHaveLength(2);

      const orderBrandIds = new Set(orderLines.map((r) => r.brandId));
      expect(orderBrandIds.size).toBe(2);
      expect(orderBrandIds.has(pizzaBrandId)).toBe(true);
      expect(orderBrandIds.has(burgerBrandId)).toBe(true);

      // Snapshots non-empty for every line.
      for (const line of orderLines) {
        expect(line.brandNameSnapshot.length).toBeGreaterThan(0);
        expect(line.nameSnapshot.length).toBeGreaterThan(0);
      }

      // Cart status flipped, intent status 'placed'.
      const [reloadedCart] = await db
        .select({ status: carts.status })
        .from(carts)
        .where(eq(carts.id, cart.id))
        .limit(1);
      const [reloadedOrder] = await db
        .select({ status: orderIntents.status, totalCents: orderIntents.totalCents })
        .from(orderIntents)
        .where(eq(orderIntents.id, order.id))
        .limit(1);
      expect(reloadedCart?.status).toBe('converted');
      expect(reloadedOrder?.status).toBe('placed');
      expect(reloadedOrder?.totalCents).toBe(subtotalCents);
    });

    test('FK policy — throwaway tenant hard-delete cascades cleanly through order_intents + items', async () => {
      // Protects the dual-cascade-path policy: tenant deletion reaches
      // `orders` both via `orders.tenant_id CASCADE` and via `tenants →
      // tenant_end_users → orders.tenant_end_user_id SET NULL`. Postgres
      // permits multiple paths but mixed actions can produce surprising
      // ordering; this test asserts the net result is "everything gone, no
      // FK error".

      // === Setup: build a complete throwaway tenant tree ===
      const slug = `commerce-cascade-${nonce()}`;
      const [throwawayTenant] = await db
        .insert(tenants)
        .values({ slug, name: 'Commerce Cascade Test', status: 'active' })
        .returning({ id: tenants.id });
      if (!throwawayTenant) throw new Error('failed to insert throwaway tenant');
      throwawayTenantId = throwawayTenant.id;

      const [throwawayBrand] = await db
        .insert(brands)
        .values({
          tenantId: throwawayTenant.id,
          slug: `${slug}-brand`,
          name: 'Cascade Brand',
          isActive: true,
          brandingJson: {},
        })
        .returning({ id: brands.id });
      if (!throwawayBrand) throw new Error('failed to insert throwaway brand');

      const [throwawayLocation] = await db
        .insert(locations)
        .values({
          tenantId: throwawayTenant.id,
          name: 'Cascade Kitchen',
          addressLine1: '1 Cascade Way',
          city: 'Brooklyn',
          state: 'NY',
          postalCode: '11201',
          country: 'US',
        })
        .returning({ id: locations.id });
      if (!throwawayLocation) throw new Error('failed to insert throwaway location');

      const [throwawayMenu] = await db
        .insert(menus)
        .values({ brandId: throwawayBrand.id, name: 'Cascade Menu', isActive: true })
        .returning({ id: menus.id });
      if (!throwawayMenu) throw new Error('failed to insert throwaway menu');

      const [throwawayMenuItem] = await db
        .insert(menuItems)
        .values({
          menuId: throwawayMenu.id,
          name: 'Cascade Item',
          priceCents: 999,
          isActive: true,
        })
        .returning({ id: menuItems.id });
      if (!throwawayMenuItem) throw new Error('failed to insert throwaway menu item');

      const [throwawayEndUser] = await db
        .insert(tenantEndUsers)
        .values({
          tenantId: throwawayTenant.id,
          email: `cascade+${nonce()}@del24.local`,
          name: 'Cascade User',
          emailVerified: true,
        })
        .returning({ id: tenantEndUsers.id });
      if (!throwawayEndUser) throw new Error('failed to insert throwaway end-user');

      const [throwawayCart] = await db
        .insert(carts)
        .values({
          tenantId: throwawayTenant.id,
          locationId: throwawayLocation.id,
          tenantEndUserId: throwawayEndUser.id,
          status: 'active',
          fulfillmentType: 'pickup',
        })
        .returning({ id: carts.id });
      if (!throwawayCart) throw new Error('failed to insert throwaway cart');

      await db.insert(cartItems).values({
        cartId: throwawayCart.id,
        brandId: throwawayBrand.id,
        menuItemId: throwawayMenuItem.id,
        quantity: 1,
        unitPriceCents: 999,
      });

      const [throwawayOrder] = await db
        .insert(orderIntents)
        .values({
          tenantId: throwawayTenant.id,
          locationId: throwawayLocation.id,
          tenantEndUserId: throwawayEndUser.id,
          placedByActorType: 'tenant_end_user',
          placedByActorId: throwawayEndUser.id,
          subtotalCents: 999,
          totalCents: 999,
        })
        .returning({ id: orderIntents.id });
      if (!throwawayOrder) throw new Error('failed to insert throwaway order intent');

      await db.insert(orderIntentItems).values({
        orderIntentId: throwawayOrder.id,
        brandId: throwawayBrand.id,
        brandNameSnapshot: 'Cascade Brand',
        menuItemIdSnapshot: throwawayMenuItem.id,
        nameSnapshot: 'Cascade Item',
        quantity: 1,
        unitPriceCents: 999,
        totalCents: 999,
      });

      // === Act: delete the throwaway tenant ===
      // Postgres resolves the dual cascade paths in one transaction. No
      // assertion needed here — if the DELETE raises a FK violation, the
      // test fails with that error.
      await db.delete(tenants).where(eq(tenants.id, throwawayTenant.id));

      // afterAll's `if (throwawayTenantId)` guard will be a no-op now; mark
      // cleared so cleanup logic skips re-deleting.
      throwawayTenantId = undefined;

      // === Assert: every child row is gone ===
      const [tenantsCount] = await db
        .select({ n: count() })
        .from(tenants)
        .where(eq(tenants.id, throwawayTenant.id));
      expect(tenantsCount?.n).toBe(0);

      const [brandsCount] = await db
        .select({ n: count() })
        .from(brands)
        .where(eq(brands.tenantId, throwawayTenant.id));
      expect(brandsCount?.n).toBe(0);

      const [locationsCount] = await db
        .select({ n: count() })
        .from(locations)
        .where(eq(locations.tenantId, throwawayTenant.id));
      expect(locationsCount?.n).toBe(0);

      const [menusCount] = await db
        .select({ n: count() })
        .from(menus)
        .where(eq(menus.brandId, throwawayBrand.id));
      expect(menusCount?.n).toBe(0);

      const [menuItemsCount] = await db
        .select({ n: count() })
        .from(menuItems)
        .where(eq(menuItems.menuId, throwawayMenu.id));
      expect(menuItemsCount?.n).toBe(0);

      const [endUsersCount] = await db
        .select({ n: count() })
        .from(tenantEndUsers)
        .where(eq(tenantEndUsers.tenantId, throwawayTenant.id));
      expect(endUsersCount?.n).toBe(0);

      const [cartsCount] = await db
        .select({ n: count() })
        .from(carts)
        .where(eq(carts.tenantId, throwawayTenant.id));
      expect(cartsCount?.n).toBe(0);

      const [cartItemsCount] = await db
        .select({ n: count() })
        .from(cartItems)
        .where(eq(cartItems.cartId, throwawayCart.id));
      expect(cartItemsCount?.n).toBe(0);

      const [ordersCount] = await db
        .select({ n: count() })
        .from(orderIntents)
        .where(eq(orderIntents.tenantId, throwawayTenant.id));
      expect(ordersCount?.n).toBe(0);

      const [lineItemsCount] = await db
        .select({ n: count() })
        .from(orderIntentItems)
        .where(eq(orderIntentItems.orderIntentId, throwawayOrder.id));
      expect(lineItemsCount?.n).toBe(0);
    });
  });
