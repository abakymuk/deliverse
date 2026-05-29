import { expect, test } from '@playwright/test';
import { db } from '@rp/db';
import {
  brands,
  cartItems,
  carts,
  menuItems,
  menus,
  orderFulfillments,
  orderIntentItems,
  orderIntents,
  tenantEndUsers,
  tenants,
} from '@rp/db/schema';
import { and, asc, count, eq, isNull } from 'drizzle-orm';

/**
 * DEL-25 PR 25c — full food-hall mode-3 flow on
 * `oomi-kitchen-test.localhost:3001`.
 *
 * AC#7 of DEL-25 — covers the user-visible flow end-to-end:
 *   1. Tenant-host home renders the directory of OOMI brands.
 *   2. Click into OOMI Burger subsection → menu renders.
 *   3. Anonymous "Add" → redirected to /login?next=/b/oomi-burger-test.
 *   4. Sign up (HTTP fast-path via /api/auth/sign-up/email with password —
 *      keeps the test independent of Inngest dev being up; the OTP signup
 *      path is already covered by `storefront-host-resolution.spec.ts`
 *      test 9). Cookie persists in the page's context, so subsequent
 *      navigations are authenticated.
 *   5. Re-add a burger menu item → cart_item written.
 *   6. Navigate to OOMI Pizza subsection → add a pizza menu item.
 *   7. Navigate to /cart → assert two lines grouped by brand.
 *   8. Click "Proceed to checkout" → fulfillment-type picker visible.
 *   9. Pick "pickup", click "Place order" → land on /orders/<id>.
 *  10. Assert order-detail page renders snapshots from both brands.
 *  11. DB assertion: one orders row, two order_line_items rows with
 *      distinct brand_id values matching the seeded OOMI brand UUIDs,
 *      snapshots non-empty.
 *
 * Fixture lifecycle: the test creates an ephemeral tenant_end_user under
 * the canonical OOMI tenant. afterAll deletes the test order first (so
 * it's tracked while user.id is still in scope) then deletes the user
 * (which cascades carts + cart_items + sessions via FK CASCADE). Order
 * deletion is targeted to the captured `orderId` (guard for failed
 * setup).
 *
 * Spec: docs/specs/food-hall-storefront.md §"AC#7 scope".
 */

const STOREFRONT_PORT = 3001;
const OOMI_STOREFRONT_SLUG = 'oomi-kitchen-test';
const OOMI_BURGER_SLUG = 'oomi-burger-test';
const OOMI_PIZZA_SLUG = 'oomi-pizza-test';

const oomiOrigin = `http://${OOMI_STOREFRONT_SLUG}.localhost:${STOREFRONT_PORT}`;

function nonce(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// Serial: single test owns its own ephemeral user + order. afterAll
// cleanup depends on captured ids; parallel workers would race the
// deletes.
test.describe.serial(
  'DEL-25 — food-hall full flow on oomi-kitchen-test',
  () => {
    let oomiTenantId: string;
    let oomiBurgerId: string;
    let oomiPizzaId: string;
    let userId: string | undefined;
    let orderId: string | undefined;

    test.beforeAll(async () => {
      // Resolve canonical OOMI tenant + brand IDs (seeded by the
      // deploy's `pnpm db:seed` step + locally by `pnpm db:seed`).
      const [tenantRow] = await db
        .select({ id: tenants.id })
        .from(tenants)
        .where(
          and(eq(tenants.slug, OOMI_STOREFRONT_SLUG), isNull(tenants.deletedAt)),
        )
        .limit(1);
      if (!tenantRow) {
        throw new Error(
          'OOMI tenant not seeded — run `pnpm db:seed` (canonical seed; not gated on SEED_TEST_FIXTURES).',
        );
      }
      oomiTenantId = tenantRow.id;

      const brandRows = await db
        .select({ id: brands.id, slug: brands.slug })
        .from(brands)
        .where(
          and(eq(brands.tenantId, oomiTenantId), isNull(brands.deletedAt)),
        );
      const burger = brandRows.find((b) => b.slug === OOMI_BURGER_SLUG);
      const pizza = brandRows.find((b) => b.slug === OOMI_PIZZA_SLUG);
      if (!burger || !pizza) {
        throw new Error('OOMI brands not seeded');
      }
      oomiBurgerId = burger.id;
      oomiPizzaId = pizza.id;
    });

    test.afterAll(async () => {
      // Intent cleanup BEFORE user cleanup — once the user is deleted,
      // order_intents.tenant_end_user_id is SET NULL and the row is no longer
      // findable by user id. Cascades to items/fulfillments. Guards on
      // undefined ids in case setup or a test step failed mid-flow.
      if (orderId) await db.delete(orderIntents).where(eq(orderIntents.id, orderId));
      if (userId)
        await db.delete(tenantEndUsers).where(eq(tenantEndUsers.id, userId));
    });

    test('full flow: signup → add from 2 brands → cart → checkout → order detail', async ({
      page,
    }) => {
      // === 1. Tenant-host directory ===
      await page.goto(`${oomiOrigin}/`);
      await expect(
        page.getByRole('heading', { name: /OOMI Kitchen/i }),
      ).toBeVisible();
      await expect(page.getByText('Choose a brand to start your order.')).toBeVisible();
      await expect(page.getByText('OOMI Burger', { exact: true })).toBeVisible();
      await expect(page.getByText('OOMI Pizza', { exact: true })).toBeVisible();

      // === 2-3. Navigate into OOMI Burger; "Add" anonymously → /login ===
      await page.getByRole('link', { name: /OOMI Burger/i }).first().click();
      await expect(page).toHaveURL(new RegExp(`/b/${OOMI_BURGER_SLUG}$`));
      await expect(
        page.getByRole('heading', { name: /OOMI Burger Menu/i }),
      ).toBeVisible();

      // Click the first "Add" button (Smash Burger). The action calls
      // addToCartAction; no session → redirect to /login?next=...
      await page
        .getByRole('button', { name: 'Add', exact: true })
        .first()
        .click();
      await expect(page).toHaveURL(/\/login\?next=/);

      // === 4. HTTP signup fast-path (password) — keeps test independent of
      // Inngest dev. Cookie persists in page's context. ===
      const email = `food-hall-e2e+${nonce()}@deliverse.test`;
      const password = 'food-hall-e2e-pass-12chars';
      const signupRes = await page.context().request.post(
        `${oomiOrigin}/api/auth/sign-up/email`,
        {
          data: {
            name: 'Food Hall E2E',
            email,
            password,
          },
          headers: { Origin: oomiOrigin },
        },
      );
      expect(
        signupRes.status(),
        `signup body: ${await signupRes.text()}`,
      ).toBe(200);

      // Capture the user id for cleanup.
      const [userRow] = await db
        .select({ id: tenantEndUsers.id })
        .from(tenantEndUsers)
        .where(
          and(
            eq(tenantEndUsers.tenantId, oomiTenantId),
            eq(tenantEndUsers.email, email),
            isNull(tenantEndUsers.deletedAt),
          ),
        )
        .limit(1);
      if (!userRow) throw new Error('user row not created after signup');
      userId = userRow.id;

      // === 5. Re-add the burger item, this time authenticated ===
      await page.goto(`${oomiOrigin}/b/${OOMI_BURGER_SLUG}`);
      await page
        .getByRole('button', { name: 'Add', exact: true })
        .first()
        .click();
      // After add, the action revalidates /b/<slug>; the page reloads in
      // place (no redirect). Wait for the cart-link counter to reflect 1.
      await expect(page.getByRole('link', { name: /View cart \(1\)/i }))
        .toBeVisible();

      // === 6. Switch to OOMI Pizza subsection; add a pizza ===
      await page.goto(`${oomiOrigin}/b/${OOMI_PIZZA_SLUG}`);
      await expect(
        page.getByRole('heading', { name: /OOMI Pizza Menu/i }),
      ).toBeVisible();
      await page
        .getByRole('button', { name: 'Add', exact: true })
        .first()
        .click();
      await expect(page.getByRole('link', { name: /View cart \(2\)/i }))
        .toBeVisible();

      // === 7. /cart shows two lines grouped by brand ===
      await page.getByRole('link', { name: /View cart/i }).click();
      await expect(page).toHaveURL(/\/cart$/);
      await expect(
        page.getByRole('heading', { name: /OOMI Burger/i }),
      ).toBeVisible();
      await expect(
        page.getByRole('heading', { name: /OOMI Pizza/i }),
      ).toBeVisible();

      // === 8. Proceed to checkout ===
      await page.getByRole('link', { name: /Proceed to checkout/i }).click();
      await expect(page).toHaveURL(/\/checkout$/);
      await expect(
        page.getByRole('heading', { name: /Checkout/i }),
      ).toBeVisible();
      // Fulfillment radios visible.
      await expect(page.getByRole('radio', { name: 'Pickup' })).toBeVisible();
      await expect(page.getByRole('radio', { name: 'Delivery' })).toBeVisible();

      // === 9. Place order (pickup default) → /orders/<id> ===
      await page.getByRole('button', { name: /Place order/i }).click();
      await expect(page).toHaveURL(/\/orders\/[0-9a-f-]+$/);
      const url = new URL(page.url());
      const capturedOrderId = url.pathname.split('/').pop() ?? '';
      expect(capturedOrderId.length).toBeGreaterThan(20);
      orderId = capturedOrderId;

      // === 10. Order detail shows snapshots from both brands ===
      await expect(
        page.getByRole('heading', { name: /Order placed/i }),
      ).toBeVisible();
      await expect(
        page.getByRole('heading', { name: 'OOMI Burger', exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole('heading', { name: 'OOMI Pizza', exact: true }),
      ).toBeVisible();

      // === 11. DB assertion (DEL-32 / X1): one order_intents row (status
      // 'placed'), two order_intent_items with distinct brand_ids matching the
      // seeded OOMI brands, and ONE order_fulfillments per brand (2 total). ===
      const [intent] = await db
        .select()
        .from(orderIntents)
        .where(eq(orderIntents.id, capturedOrderId))
        .limit(1);
      if (!intent) throw new Error('order_intents row not found after checkout');
      expect(intent.tenantId).toBe(oomiTenantId);
      expect(intent.tenantEndUserId).toBe(userId);
      expect(intent.status).toBe('placed');
      expect(intent.placedByActorType).toBe('tenant_end_user');

      const lineRows = await db
        .select({
          id: orderIntentItems.id,
          brandId: orderIntentItems.brandId,
          brandNameSnapshot: orderIntentItems.brandNameSnapshot,
          nameSnapshot: orderIntentItems.nameSnapshot,
        })
        .from(orderIntentItems)
        .where(eq(orderIntentItems.orderIntentId, capturedOrderId))
        .orderBy(asc(orderIntentItems.brandNameSnapshot));
      expect(lineRows).toHaveLength(2);
      const brandIds = new Set(lineRows.map((r) => r.brandId));
      expect(brandIds.size).toBe(2);
      expect(brandIds.has(oomiBurgerId)).toBe(true);
      expect(brandIds.has(oomiPizzaId)).toBe(true);
      for (const line of lineRows) {
        expect(line.brandNameSnapshot.length).toBeGreaterThan(0);
        expect(line.nameSnapshot.length).toBeGreaterThan(0);
      }

      // One fulfillment per brand (the KDS ticket), each born 'queued'.
      const fulfillmentRows = await db
        .select({
          brandId: orderFulfillments.brandId,
          status: orderFulfillments.status,
          fulfillmentType: orderFulfillments.fulfillmentType,
          tenantId: orderFulfillments.tenantId,
        })
        .from(orderFulfillments)
        .where(eq(orderFulfillments.orderIntentId, capturedOrderId))
        .orderBy(asc(orderFulfillments.brandNameSnapshot));
      expect(fulfillmentRows).toHaveLength(2);
      const fBrandIds = new Set(fulfillmentRows.map((r) => r.brandId));
      expect(fBrandIds.has(oomiBurgerId)).toBe(true);
      expect(fBrandIds.has(oomiPizzaId)).toBe(true);
      for (const f of fulfillmentRows) {
        expect(f.status).toBe('queued');
        expect(f.fulfillmentType).toBe('pickup');
        expect(f.tenantId).toBe(oomiTenantId);
      }

      // Cart row converted (not 'active' anymore).
      const [cart] = await db
        .select({ status: carts.status })
        .from(carts)
        .where(eq(carts.tenantEndUserId, userId))
        .orderBy(asc(carts.createdAt))
        .limit(1);
      expect(cart?.status).toBe('converted');

      // Sanity: cart_items rows still exist for the converted cart (we
      // don't cascade-delete them; cart status='converted' is the audit
      // marker).
      const [cartItemCount] = await db
        .select({ n: count() })
        .from(cartItems)
        .innerJoin(carts, eq(carts.id, cartItems.cartId))
        .where(eq(carts.tenantEndUserId, userId));
      expect(cartItemCount?.n).toBe(2);
    });
  },
);
