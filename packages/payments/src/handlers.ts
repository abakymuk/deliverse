/**
 * Stripe webhook handlers — pure (tx, …) → DB-effects functions.
 *
 * Each handler takes an ALREADY-VERIFIED, parsed Stripe object and runs inside
 * the route's db.transaction. They deliberately do NOT import the Stripe client
 * (no outbound API calls in the webhook path — everything needed is on the
 * event payload), which keeps the Stripe SDK out of the DB-backed handler tests.
 *
 * account.updated (onboarding) + payment_intent.succeeded (capture) are wired;
 * refund (charge.refunded) lands in step 4.
 */

import type { Transaction } from '@rp/db';
import { payments, tenants } from '@rp/db/schema';
import { appendEvent } from '@rp/events/writer';
import { eq } from 'drizzle-orm';
import type Stripe from 'stripe';
import { z } from 'zod';
import { PermanentWebhookError } from './errors';

const tenantIdSchema = z.string().uuid();

/** PaymentIntent.metadata contract (stamped by the future pay-UI ticket). */
const paymentMetadataSchema = z.object({
  tenant_id: z.string().uuid(),
  order_intent_id: z.string().uuid(),
});

/**
 * account.updated → flip tenants.stripe_charges_enabled.
 *
 * Resolve the tenant by account.metadata.tenant_id (stamped at account
 * creation), falling back to a match on stripe_account_id. An unresolvable
 * account is a PERMANENT error: the route ACKs 200 + logs rather than letting
 * Stripe retry forever.
 */
export async function handleAccountUpdated(
  tx: Transaction,
  account: Stripe.Account,
): Promise<void> {
  const metadataTenantId = tenantIdSchema.safeParse(account.metadata?.tenant_id);

  const [tenant] = metadataTenantId.success
    ? await tx
        .select({ id: tenants.id })
        .from(tenants)
        .where(eq(tenants.id, metadataTenantId.data))
        .limit(1)
    : await tx
        .select({ id: tenants.id })
        .from(tenants)
        .where(eq(tenants.stripeAccountId, account.id))
        .limit(1);

  if (!tenant) {
    throw new PermanentWebhookError(
      `account.updated: no tenant for connected account ${account.id}`,
    );
  }

  await tx
    .update(tenants)
    .set({
      stripeChargesEnabled: account.charges_enabled,
      updatedAt: new Date(),
    })
    .where(eq(tenants.id, tenant.id));
}

/**
 * payment_intent.succeeded → idempotent `payments` row + `payment.captured`.
 *
 * tenant_id + order_intent_id come from PaymentIntent.metadata (the contract the
 * future pay-UI ticket fulfils). Destination charge: amount_received is the
 * captured amount, application_fee_amount the platform cut. UNIQUE(provider,
 * external_id) + ON CONFLICT DO NOTHING makes a redelivered webhook a no-op, and
 * the event is emitted ONLY when a genuinely new row is inserted (the outbox
 * idempotency_key on external_id is the second guard). Missing/invalid metadata
 * is a PERMANENT error → the route ACKs 200 + logs.
 */
export async function handlePaymentIntentSucceeded(
  tx: Transaction,
  paymentIntent: Stripe.PaymentIntent,
): Promise<void> {
  const meta = paymentMetadataSchema.safeParse(paymentIntent.metadata);
  if (!meta.success) {
    throw new PermanentWebhookError(
      `payment_intent.succeeded ${paymentIntent.id}: missing/invalid tenant_id|order_intent_id metadata`,
    );
  }
  const { tenant_id: tenantId, order_intent_id: orderIntentId } = meta.data;

  const capturedAt = new Date(paymentIntent.created * 1000);
  const amountCents = paymentIntent.amount_received;
  const { currency } = paymentIntent;

  const [inserted] = await tx
    .insert(payments)
    .values({
      tenantId,
      orderIntentId,
      provider: 'stripe',
      externalId: paymentIntent.id,
      amountCents,
      currency,
      applicationFeeCents: paymentIntent.application_fee_amount ?? null,
      status: 'captured',
      capturedAt,
    })
    .onConflictDoNothing({ target: [payments.provider, payments.externalId] })
    .returning({ id: payments.id });

  // Replayed webhook (row already exists) → nothing inserted, emit nothing.
  if (!inserted) return;

  await appendEvent(tx, {
    name: 'payment.captured',
    data: {
      tenantId,
      occurredAt: capturedAt.toISOString(),
      actorType: 'system',
      actorId: null,
      paymentId: inserted.id,
      orderIntentId,
      externalId: paymentIntent.id,
      amountCents,
      currency,
    },
  });
}

/**
 * Route a verified Stripe event to its handler inside the supplied tx.
 * Unhandled event types are a no-op — the route ACKs 200, since we don't want
 * Stripe retrying events we intentionally ignore. Capture/refund cases land in
 * steps 3-4.
 */
export async function dispatchStripeEvent(
  tx: Transaction,
  event: Stripe.Event,
): Promise<void> {
  switch (event.type) {
    case 'account.updated':
      return handleAccountUpdated(tx, event.data.object);
    case 'payment_intent.succeeded':
      return handlePaymentIntentSucceeded(tx, event.data.object);
    default:
      return;
  }
}

/**
 * Event types {@link dispatchStripeEvent} acts on. The webhook route checks this
 * BEFORE opening a db.transaction so Stripe events we ignore are ACKed 200
 * without a DB round-trip. Keep in sync with the switch above — step 4 adds
 * 'charge.refunded'.
 */
export const HANDLED_STRIPE_EVENT_TYPES: ReadonlySet<Stripe.Event['type']> = new Set([
  'account.updated',
  'payment_intent.succeeded',
]);
