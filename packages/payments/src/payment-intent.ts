/**
 * Create a Stripe PaymentIntent for a placed order_intent (DEL-44).
 *
 * Destination charge (Express + Connect, per X4): funds route to the tenant's
 * connected account via `transfer_data[destination]`. v1 takes NO platform fee
 * (`application_fee_amount` omitted — the full amount transfers to the
 * restaurant); the fee policy is a later ticket. `metadata.{tenant_id,
 * order_intent_id}` is the contract the capture webhook
 * (`handlePaymentIntentSucceeded`) reads to record the `payments` row + emit
 * `payment.captured`.
 *
 * The Stripe idempotency key is derived from the order_intent id, so repeated
 * calls (re-render, retry) return the SAME PaymentIntent rather than creating
 * duplicates.
 *
 * Guards throw (the caller surfaces a user-facing error): the order must exist +
 * be 'placed', must not already be paid, and the tenant must be charges-enabled.
 * All guards run BEFORE the Stripe call (`getStripe()`), so a non-chargeable
 * order never touches Stripe.
 */

import { db } from '@rp/db';
import { orderIntents, payments, tenants } from '@rp/db/schema';
import { and, eq, inArray } from 'drizzle-orm';
import { getStripe } from './client';

export async function createPaymentIntentForOrder(
  orderIntentId: string,
): Promise<{ clientSecret: string }> {
  const [order] = await db
    .select({
      id: orderIntents.id,
      tenantId: orderIntents.tenantId,
      totalCents: orderIntents.totalCents,
      status: orderIntents.status,
    })
    .from(orderIntents)
    .where(eq(orderIntents.id, orderIntentId))
    .limit(1);

  if (!order) {
    throw new Error(`createPaymentIntentForOrder: order_intent ${orderIntentId} not found`);
  }
  if (order.status !== 'placed') {
    throw new Error(
      `createPaymentIntentForOrder: order_intent ${orderIntentId} is '${order.status}', not 'placed'`,
    );
  }

  const alreadyPaid = await db
    .select({ id: payments.id })
    .from(payments)
    .where(
      and(
        eq(payments.orderIntentId, orderIntentId),
        inArray(payments.status, ['captured', 'partially_refunded', 'refunded']),
      ),
    )
    .limit(1);
  if (alreadyPaid.length > 0) {
    throw new Error(`createPaymentIntentForOrder: order_intent ${orderIntentId} is already paid`);
  }

  const [tenant] = await db
    .select({
      stripeAccountId: tenants.stripeAccountId,
      chargesEnabled: tenants.stripeChargesEnabled,
    })
    .from(tenants)
    .where(eq(tenants.id, order.tenantId))
    .limit(1);
  if (!tenant?.stripeAccountId || !tenant.chargesEnabled) {
    throw new Error(`createPaymentIntentForOrder: tenant ${order.tenantId} is not charges-enabled`);
  }

  const paymentIntent = await getStripe().paymentIntents.create(
    {
      amount: order.totalCents,
      currency: 'usd',
      automatic_payment_methods: { enabled: true },
      // Destination charge → funds to the connected account. No application fee
      // in v1 (locked decision): the full amount transfers to the restaurant.
      transfer_data: { destination: tenant.stripeAccountId },
      metadata: { tenant_id: order.tenantId, order_intent_id: order.id },
    },
    { idempotencyKey: `order-pi-${order.id}` },
  );

  if (!paymentIntent.client_secret) {
    throw new Error(
      `createPaymentIntentForOrder: Stripe returned no client_secret for ${paymentIntent.id}`,
    );
  }
  return { clientSecret: paymentIntent.client_secret };
}
