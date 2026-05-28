'use server';

import { db } from '@rp/db';
import {
  brands,
  cartItems,
  carts,
  menuItems,
  orderLineItems,
  orders,
} from '@rp/db/schema';
import { safeNextPath } from '@rp/auth-core/safe-next-path';
import { appendEvent } from '@rp/events/writer';
import { and, asc, eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth';
import { getActiveCart } from '@/lib/cart-resolver';
import { resolveStorefrontTenantContext } from '@/lib/storefront-tenant-context';

/**
 * DEL-25 PR 25c — checkout server action.
 *
 * Flow per docs/specs/food-hall-storefront.md §"Checkout":
 *
 *   1. Resolve storefront context + session. Redirect if anonymous.
 *   2. Read active cart (read-only). If null, redirect to /cart.
 *      (Empty-cart guard sits OUTSIDE the transaction — calling
 *      `redirect()` inside `db.transaction()` would have the
 *      NEXT_REDIRECT throw caught by the transaction wrapper and
 *      treated as a rollback signal.)
 *   3. Open `db.transaction(async (tx) => { ... })`:
 *      a. Load cart_items joined with menu_items + brands (snapshot
 *         data).
 *      b. Compute totals from line items.
 *      c. Insert orders row (status='confirmed', fulfillmentType from
 *         input).
 *      d. Insert order_line_items rows with snapshots (brand_name_snapshot,
 *         menu_item_id_snapshot, name_snapshot, modifiers_snapshot_json,
 *         prices).
 *      e. **Double-submit guard.** Conditional UPDATE: `UPDATE carts SET
 *         status='converted' WHERE id=$cartId AND status='active'
 *         RETURNING id`. Zero rows ⇒ throw to abort the transaction
 *         (rolls back order + line items, preventing a duplicate order).
 *      f. Return order.id.
 *   4. **After the transaction resolves**, call `redirect('/orders/' +
 *      orderId)`. `redirect()` throws NEXT_REDIRECT; calling it inside
 *      the transaction callback would have the throw caught by Drizzle
 *      and treated as a rollback.
 */
export async function placeOrderAction(formData: FormData): Promise<void> {
  const fulfillmentTypeRaw = formData.get('fulfillmentType');
  const fulfillmentType: 'pickup' | 'delivery' =
    fulfillmentTypeRaw === 'delivery' ? 'delivery' : 'pickup';

  // 1. Storefront context + session.
  const ctx = await resolveStorefrontTenantContext();
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user) {
    const safe = safeNextPath('/checkout', '/');
    redirect(`/login?next=${encodeURIComponent(safe)}`);
  }
  const tenantEndUserId = session.user.id;

  // 2. Read active cart (read-only). Redirect outside the transaction.
  const cart = await getActiveCart(ctx.tenantId, tenantEndUserId);
  if (!cart) {
    redirect('/cart');
  }

  // 3. Atomic conversion: load lines → compute totals → insert order +
  // line items → conditionally flip cart to converted.
  const orderId = await db.transaction(async (tx) => {
    // a. Load cart lines with the brand + menu_item info we need for
    // snapshots.
    const lines = await tx
      .select({
        cartItemQty: cartItems.quantity,
        cartItemUnitPriceCents: cartItems.unitPriceCents,
        cartItemModifiers: cartItems.modifiersJson,
        menuItemId: menuItems.id,
        menuItemName: menuItems.name,
        brandId: brands.id,
        brandName: brands.name,
      })
      .from(cartItems)
      .innerJoin(menuItems, eq(menuItems.id, cartItems.menuItemId))
      .innerJoin(brands, eq(brands.id, cartItems.brandId))
      .where(eq(cartItems.cartId, cart.id))
      .orderBy(asc(brands.name), asc(cartItems.createdAt));

    if (lines.length === 0) {
      throw new Error('placeOrderAction: cart is empty');
    }

    // b. Totals. v1 has no tax/fee/tip computation — all zero.
    const subtotalCents = lines.reduce(
      (acc, l) => acc + l.cartItemUnitPriceCents * l.cartItemQty,
      0,
    );
    const taxCents = 0;
    const feeCents = 0;
    const tipCents = 0;
    const totalCents = subtotalCents + taxCents + feeCents + tipCents;

    // c. Insert the orders row.
    const [order] = await tx
      .insert(orders)
      .values({
        tenantId: cart.tenantId,
        locationId: cart.locationId,
        tenantEndUserId,
        status: 'confirmed',
        fulfillmentType,
        subtotalCents,
        taxCents,
        feeCents,
        tipCents,
        totalCents,
      })
      .returning({ id: orders.id });
    if (!order) {
      throw new Error('placeOrderAction: failed to insert order');
    }

    // d. Insert line items with snapshots.
    await tx.insert(orderLineItems).values(
      lines.map((l) => ({
        orderId: order.id,
        brandId: l.brandId,
        brandNameSnapshot: l.brandName,
        menuItemIdSnapshot: l.menuItemId,
        nameSnapshot: l.menuItemName,
        quantity: l.cartItemQty,
        modifiersSnapshotJson: l.cartItemModifiers,
        unitPriceCents: l.cartItemUnitPriceCents,
        totalCents: l.cartItemUnitPriceCents * l.cartItemQty,
      })),
    );

    // d2. DEL-29 / N2: emit order.placed in the same tx as the order +
    // line items. If the double-submit guard below rolls back, the event
    // rolls back too — consumers never see a duplicate. The dispatcher
    // publishes asynchronously. Event name renames to `order_intent.placed`
    // when DEL-32 / X1 (Order Intent split) lands.
    await appendEvent(tx, {
      name: 'order.placed',
      data: {
        tenantId: cart.tenantId,
        occurredAt: new Date().toISOString(),
        actorType: 'tenant_end_user',
        actorId: tenantEndUserId,
        orderId: order.id,
        cartId: cart.id,
        locationId: cart.locationId,
        fulfillmentType,
        totalCents,
        subtotalCents,
        // Distinct brands across line items — for food-hall analytics.
        brandIds: Array.from(new Set(lines.map((l) => l.brandId))),
        lineItemCount: lines.length,
      },
    });

    // e. Double-submit guard: only flip carts where status is still
    // 'active'. If a parallel submit already converted the cart, the
    // UPDATE returns zero rows — throw to abort the transaction and
    // roll back the order + line items.
    const converted = await tx
      .update(carts)
      .set({ status: 'converted' })
      .where(and(eq(carts.id, cart.id), eq(carts.status, 'active')))
      .returning({ id: carts.id });
    if (converted.length === 0) {
      throw new Error('placeOrderAction: cart already checked out');
    }

    return order.id;
  });

  // 4. AFTER the transaction resolves. `redirect()` throws NEXT_REDIRECT;
  // calling it inside `db.transaction(...)` would have the throw caught
  // by Drizzle and trigger a rollback.
  revalidatePath('/cart');
  revalidatePath('/orders');
  redirect(`/orders/${orderId}`);
}
