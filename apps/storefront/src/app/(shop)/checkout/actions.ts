'use server';

import { db } from '@rp/db';
import {
  brands,
  cartItems,
  carts,
  menuItems,
  orderFulfillmentItems,
  orderFulfillments,
  orderIntentItems,
  orderIntents,
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
 * Checkout server action (DEL-25; refactored for DEL-32 / X1 Order Intent split).
 *
 * Flow per docs/specs/order-intent-fulfillment-split.md:
 *
 *   1. Resolve storefront context + session. Redirect if anonymous.
 *   2. Read active cart (read-only). If null, redirect to /cart.
 *      (Empty-cart + redirect guards sit OUTSIDE the transaction — calling
 *      `redirect()` inside `db.transaction()` would have the NEXT_REDIRECT
 *      throw caught by the tx wrapper and treated as a rollback.)
 *   3. Open `db.transaction(async (tx) => { ... })`:
 *      a. Load cart_items joined with menu_items + brands (snapshot data).
 *      b. Compute totals from line items.
 *      c. Insert ONE order_intents row (status defaults 'placed';
 *         placed_by_actor = the authenticated guest; idempotency_key NULL —
 *         the cart-conversion guard is the storefront dedup).
 *      d. Insert order_intent_items (immutable snapshots).
 *      e. Insert ONE order_fulfillments row per distinct brand (the KDS
 *         ticket), then order_fulfillment_items mapping each line into its
 *         brand's fulfillment.
 *      f. Emit order_intent.placed (same tx — rolls back with the intent).
 *      g. **Double-submit guard.** Conditional `UPDATE carts SET
 *         status='converted' WHERE id=$cartId AND status='active'`. Zero
 *         rows ⇒ throw to abort the tx (rolls back the whole intent).
 *      h. Return the order_intent id.
 *   4. **After the tx resolves**, `redirect('/orders/' + orderIntentId)`.
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
  const orderIntentId = await db.transaction(async (tx) => {
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

    // c. Insert the order intent (aggregate root). status defaults 'placed'.
    const [intent] = await tx
      .insert(orderIntents)
      .values({
        tenantId: cart.tenantId,
        locationId: cart.locationId,
        tenantEndUserId,
        channel: 'storefront',
        // X2: storefront checkout acts as the authenticated guest.
        placedByActorType: 'tenant_end_user',
        placedByActorId: tenantEndUserId,
        // Storefront dedup is the cart-conversion guard (step g); the
        // idempotency_key UNIQUE is reserved for the agent/API path (L3).
        idempotencyKey: null,
        subtotalCents,
        taxCents,
        feeCents,
        tipCents,
        totalCents,
      })
      .returning({ id: orderIntents.id });
    if (!intent) {
      throw new Error('placeOrderAction: failed to insert order intent');
    }

    // d. Insert intent items (immutable snapshots). Postgres preserves the
    // VALUES order in RETURNING, so insertedItems[i] corresponds to lines[i].
    const insertedItems = await tx
      .insert(orderIntentItems)
      .values(
        lines.map((l) => ({
          orderIntentId: intent.id,
          brandId: l.brandId,
          brandNameSnapshot: l.brandName,
          menuItemIdSnapshot: l.menuItemId,
          nameSnapshot: l.menuItemName,
          quantity: l.cartItemQty,
          modifiersSnapshotJson: l.cartItemModifiers,
          unitPriceCents: l.cartItemUnitPriceCents,
          totalCents: l.cartItemUnitPriceCents * l.cartItemQty,
        })),
      )
      .returning({
        id: orderIntentItems.id,
        brandId: orderIntentItems.brandId,
        quantity: orderIntentItems.quantity,
      });

    // e. One fulfillment per distinct brand in the cart (the KDS ticket).
    const distinctBrands = Array.from(
      new Map(lines.map((l) => [l.brandId, l.brandName])).entries(),
    ).map(([brandId, brandName]) => ({ brandId, brandName }));

    const insertedFulfillments = await tx
      .insert(orderFulfillments)
      .values(
        distinctBrands.map((b) => ({
          orderIntentId: intent.id,
          tenantId: cart.tenantId,
          brandId: b.brandId,
          brandNameSnapshot: b.brandName,
          locationId: cart.locationId,
          fulfillmentType,
        })),
      )
      .returning({ id: orderFulfillments.id, brandId: orderFulfillments.brandId });

    const fulfillmentIdByBrand = new Map(
      insertedFulfillments.map((f) => [f.brandId, f.id]),
    );

    // f. Map each intent item into its brand's fulfillment ticket. v1 maps
    // the whole line; order_fulfillment_items allows future splits/merges.
    const fulfillmentItemValues = insertedItems.map((item) => {
      const orderFulfillmentId = fulfillmentIdByBrand.get(item.brandId);
      if (!orderFulfillmentId) {
        throw new Error('placeOrderAction: no fulfillment for line item brand');
      }
      return {
        orderFulfillmentId,
        orderIntentItemId: item.id,
        quantity: item.quantity,
      };
    });
    await tx.insert(orderFulfillmentItems).values(fulfillmentItemValues);

    // g. DEL-29/N2 + DEL-32/X1: emit order_intent.placed in the same tx as
    // the intent + items + fulfillments. If the double-submit guard below
    // rolls back, the event rolls back too — consumers never see a duplicate.
    // The dispatcher publishes asynchronously.
    await appendEvent(tx, {
      name: 'order_intent.placed',
      data: {
        tenantId: cart.tenantId,
        occurredAt: new Date().toISOString(),
        actorType: 'tenant_end_user',
        actorId: tenantEndUserId,
        orderIntentId: intent.id,
        cartId: cart.id,
        locationId: cart.locationId,
        totalCents,
        subtotalCents,
        // Distinct brands across line items — for food-hall analytics.
        brandIds: distinctBrands.map((b) => b.brandId),
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

    return intent.id;
  });

  // 4. AFTER the transaction resolves. `redirect()` throws NEXT_REDIRECT;
  // calling it inside `db.transaction(...)` would have the throw caught
  // by Drizzle and trigger a rollback.
  revalidatePath('/cart');
  revalidatePath('/orders');
  redirect(`/orders/${orderIntentId}`);
}
