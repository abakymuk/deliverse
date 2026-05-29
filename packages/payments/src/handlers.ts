/**
 * Stripe webhook handlers — pure (tx, …) → DB-effects functions.
 *
 * Each handler takes an ALREADY-VERIFIED, parsed Stripe object and runs inside
 * the route's db.transaction. They deliberately do NOT import the Stripe client
 * (no outbound API calls in the webhook path — everything needed is on the
 * event payload), which keeps the Stripe SDK out of the DB-backed handler tests.
 *
 * account.updated (onboarding), payment_intent.succeeded (capture), and
 * charge.refunded (refund, full unwind) are all wired.
 */

import type { Transaction } from '@rp/db';
import { orderModifications, payments, refunds, tenants } from '@rp/db/schema';
import { appendEvent } from '@rp/events/writer';
import { and, eq } from 'drizzle-orm';
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

/** Map Stripe's refund status onto our refund_status enum. */
function mapRefundStatus(
  status: Stripe.Refund['status'],
): 'pending' | 'succeeded' | 'failed' | 'canceled' {
  switch (status) {
    case 'succeeded':
      return 'succeeded';
    case 'failed':
      return 'failed';
    case 'canceled':
      return 'canceled';
    default:
      // 'pending', 'requires_action', or null
      return 'pending';
  }
}

/**
 * charge.refunded → refunds row(s) + order_modifications ledger + payment.refunded.
 *
 * Resolves the payment via charge.payment_intent (= payments.external_id). For
 * each Stripe refund on the charge, idempotently upserts a refunds row
 * (UNIQUE(provider, external_id)); ONLY on a newly-inserted row does it write the
 * order_modifications(kind='refund') ledger entry, link it back, recompute
 * payments.status (partially_refunded vs refunded), and emit payment.refunded.
 *
 * Full-unwind reconciliation (locked decision): transfer_reversed comes from
 * refund.transfer_reversal; the application fee is refunded on FULL refunds only,
 * so application_fee_refunded_cents = the charge fee when the charge is now fully
 * refunded, else 0. Actor is threaded from refund.metadata.platform_user_id
 * (the admin who triggered it), else 'system'.
 *
 * If no payment is found, the capture (payment_intent.succeeded) likely hasn't
 * been processed yet — throw so Stripe retries; the ordering race self-heals and
 * idempotency makes the retry safe.
 */
export async function handleChargeRefunded(
  tx: Transaction,
  charge: Stripe.Charge,
): Promise<void> {
  const paymentIntentId =
    typeof charge.payment_intent === 'string'
      ? charge.payment_intent
      : (charge.payment_intent?.id ?? null);

  if (!paymentIntentId) {
    throw new PermanentWebhookError(`charge.refunded ${charge.id}: charge has no payment_intent`);
  }

  const [payment] = await tx
    .select({
      id: payments.id,
      tenantId: payments.tenantId,
      orderIntentId: payments.orderIntentId,
      amountCents: payments.amountCents,
    })
    .from(payments)
    .where(and(eq(payments.provider, 'stripe'), eq(payments.externalId, paymentIntentId)))
    .limit(1);

  if (!payment) {
    throw new Error(
      `charge.refunded ${charge.id}: no payment for payment_intent ${paymentIntentId} (capture not processed yet?)`,
    );
  }

  const chargeFeeRefundedCents = charge.refunded ? (charge.application_fee_amount ?? null) : 0;

  for (const refund of charge.refunds?.data ?? []) {
    const [insertedRefund] = await tx
      .insert(refunds)
      .values({
        tenantId: payment.tenantId,
        paymentId: payment.id,
        provider: 'stripe',
        externalId: refund.id,
        amountCents: refund.amount,
        status: mapRefundStatus(refund.status),
        transferReversed: refund.transfer_reversal != null,
        applicationFeeRefundedCents: chargeFeeRefundedCents,
        processedAt: new Date(refund.created * 1000),
      })
      .onConflictDoNothing({ target: [refunds.provider, refunds.externalId] })
      .returning({ id: refunds.id });

    // Replay (refund already recorded) → skip ledger/status/event for this one.
    if (!insertedRefund) continue;

    // Thread the admin who triggered the refund, if present.
    const platformUserId = z.string().uuid().safeParse(refund.metadata?.platform_user_id);
    const actorType = platformUserId.success ? 'platform_user' : 'system';
    const actorId = platformUserId.success ? platformUserId.data : null;

    const [modification] = await tx
      .insert(orderModifications)
      .values({
        orderIntentId: payment.orderIntentId,
        kind: 'refund',
        actorType,
        actorId,
        payload: { refundExternalId: refund.id, paymentId: payment.id },
        financialDeltaCents: -refund.amount,
      })
      .returning({ id: orderModifications.id });

    const orderModificationId = modification?.id ?? null;

    await tx
      .update(refunds)
      .set({ orderModificationId })
      .where(eq(refunds.id, insertedRefund.id));

    // Recompute payment status from the sum of all its refunds (incl. this one,
    // visible inside the tx).
    const refundRows = await tx
      .select({ amountCents: refunds.amountCents })
      .from(refunds)
      .where(eq(refunds.paymentId, payment.id));
    const totalRefunded = refundRows.reduce((sum, r) => sum + r.amountCents, 0);
    const nextStatus = totalRefunded >= payment.amountCents ? 'refunded' : 'partially_refunded';

    await tx
      .update(payments)
      .set({ status: nextStatus, updatedAt: new Date() })
      .where(eq(payments.id, payment.id));

    await appendEvent(tx, {
      name: 'payment.refunded',
      data: {
        tenantId: payment.tenantId,
        occurredAt: new Date(refund.created * 1000).toISOString(),
        actorType,
        actorId,
        paymentId: payment.id,
        refundId: insertedRefund.id,
        externalId: refund.id,
        amountCents: refund.amount,
        orderModificationId,
      },
    });
  }
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
    case 'charge.refunded':
      return handleChargeRefunded(tx, event.data.object);
    default:
      return;
  }
}

/**
 * Event types {@link dispatchStripeEvent} acts on. The webhook route checks this
 * BEFORE opening a db.transaction so Stripe events we ignore are ACKed 200
 * without a DB round-trip. Keep in sync with the switch above.
 */
export const HANDLED_STRIPE_EVENT_TYPES: ReadonlySet<Stripe.Event['type']> = new Set([
  'account.updated',
  'payment_intent.succeeded',
  'charge.refunded',
]);
