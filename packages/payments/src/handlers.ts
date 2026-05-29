/**
 * Stripe webhook handlers — pure (tx, …) → DB-effects functions.
 *
 * Each handler takes an ALREADY-VERIFIED, parsed Stripe object and runs inside
 * the route's db.transaction. They deliberately do NOT import the Stripe client
 * (no outbound API calls in the webhook path — everything needed is on the
 * event payload), which keeps the Stripe SDK out of the DB-backed handler tests.
 *
 * Capture (payment_intent.succeeded) and refund (charge.refunded) handlers land
 * in steps 3-4. Step 2 wires account.updated for onboarding verification.
 */

import type { Transaction } from '@rp/db';
import { tenants } from '@rp/db/schema';
import { eq } from 'drizzle-orm';
import type Stripe from 'stripe';
import { z } from 'zod';
import { PermanentWebhookError } from './errors';

const tenantIdSchema = z.string().uuid();

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
    default:
      return;
  }
}

/**
 * Event types {@link dispatchStripeEvent} acts on. The webhook route checks this
 * BEFORE opening a db.transaction so Stripe events we ignore are ACKed 200
 * without a DB round-trip. Keep in sync with the switch above — steps 3-4 add
 * 'payment_intent.succeeded' and 'charge.refunded'.
 */
export const HANDLED_STRIPE_EVENT_TYPES: ReadonlySet<Stripe.Event['type']> = new Set([
  'account.updated',
]);
