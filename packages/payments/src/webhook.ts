/**
 * Stripe webhook signature verification with MULTIPLE signing secrets.
 *
 * Stripe Connect splits events across scopes: connected-account events
 * (account.updated) and platform events (payment_intent.succeeded,
 * charge.refunded) can be delivered by SEPARATE Stripe endpoints, each with its
 * own signing secret. `STRIPE_WEBHOOK_SECRET` is therefore parsed as a
 * comma-separated list and an event is accepted if ANY secret verifies it. A
 * single secret (no commas) is the degenerate case and works unchanged.
 *
 * HMAC verification is local (no Stripe API call), so this stays cheap on the
 * hot webhook path regardless of how many secrets are configured.
 */

import type Stripe from 'stripe';
import { getStripe } from './client';

/** Split `STRIPE_WEBHOOK_SECRET` into individual secrets (comma-separated). */
export function parseWebhookSecrets(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Verify `rawBody` + `signature` against each secret in turn, returning the
 * first successfully-constructed event. Throws the last verification error if
 * none match (the route maps that to 400), or if `secrets` is empty.
 */
export function constructWebhookEvent(
  rawBody: string,
  signature: string,
  secrets: string[],
): Stripe.Event {
  if (secrets.length === 0) {
    throw new Error('constructWebhookEvent: no signing secrets configured');
  }

  const { webhooks } = getStripe();
  let lastErr: unknown;
  for (const secret of secrets) {
    try {
      return webhooks.constructEvent(rawBody, signature, secret);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}
