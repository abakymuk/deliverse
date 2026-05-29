'use server';

import { db } from '@rp/db';
import { orderIntents } from '@rp/db/schema';
import { createPaymentIntentForOrder } from '@rp/payments';
import { eq } from 'drizzle-orm';
import { headers } from 'next/headers';
import { auth } from '@/lib/auth';

/**
 * Start payment for a placed order_intent (DEL-44).
 *
 * Verifies the caller owns the order (same guard as the order page), then asks
 * @rp/payments to create a destination-charge PaymentIntent and returns its
 * client_secret for the Payment Element. The `payments` row + `payment.captured`
 * are recorded by the charge webhook (X4), NOT here.
 *
 * Returns a discriminated result so the client can render an inline error
 * instead of throwing.
 */
export async function createOrderPaymentIntentAction(
  orderIntentId: string,
): Promise<{ clientSecret: string } | { error: string }> {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user) {
    return { error: 'Please sign in to pay.' };
  }

  const [order] = await db
    .select({ ownerId: orderIntents.tenantEndUserId })
    .from(orderIntents)
    .where(eq(orderIntents.id, orderIntentId))
    .limit(1);
  // Same ownership guard as the order page — never start payment for another
  // user's order (or a non-existent one).
  if (!order || order.ownerId !== session.user.id) {
    return { error: 'Order not found.' };
  }

  try {
    return await createPaymentIntentForOrder(orderIntentId);
  } catch (err) {
    console.error('[checkout] createPaymentIntent failed', { orderIntentId, err });
    return { error: 'Could not start payment. Please try again.' };
  }
}
