/**
 * Stripe webhook ingestion (DEL-35 / X4).
 *
 * Verifies the signature against the RAW body, then dispatches to @rp/payments
 * handlers inside one db.transaction. ACK discipline (Stripe retries any non-2xx
 * for ~3 days and disables the endpoint on sustained failure):
 *   - missing/invalid signature      → 400 (malformed; never worth retrying)
 *   - unhandled event.type           → 200 no-op, checked BEFORE opening a tx
 *                                       (don't make Stripe retry events we ignore)
 *   - PermanentWebhookError           → 200 + log (bad metadata / unknown tenant;
 *                                       a retry can't fix it)
 *   - anything else (DB blip, bug)    → 500 (Stripe retries; row/event
 *                                       idempotency makes the retry safe)
 *
 * Node runtime (default) — @rp/db uses `postgres`, never edge. `force-dynamic`
 * so the App Router never statically optimizes this POST. Connected-account
 * events (`account.updated`) require a CONNECT-scoped Stripe endpoint, which
 * carries its own signing secret; `STRIPE_WEBHOOK_SECRET` is a comma-separated
 * list so a connect endpoint and an account endpoint can both target this route
 * and an event is accepted if ANY configured secret verifies it.
 */

import { db } from '@rp/db';
import {
  HANDLED_STRIPE_EVENT_TYPES,
  PermanentWebhookError,
  constructWebhookEvent,
  dispatchStripeEvent,
  parseWebhookSecrets,
} from '@rp/payments';

export const dynamic = 'force-dynamic';

// Stripe.Event, resolved structurally so the platform app needs no direct
// `stripe` dependency (it isn't hoisted into apps/platform's node_modules).
type StripeEvent = ReturnType<typeof constructWebhookEvent>;

export async function POST(req: Request): Promise<Response> {
  const signature = req.headers.get('stripe-signature');
  if (!signature) {
    return new Response('Missing stripe-signature header', { status: 400 });
  }

  // Comma-separated: a CONNECT-scoped and an account-scoped endpoint can both
  // target this route, each with its own secret. Accept on the first match.
  const webhookSecrets = parseWebhookSecrets(process.env.STRIPE_WEBHOOK_SECRET);
  if (webhookSecrets.length === 0) {
    // Misconfiguration, not a client error — 500 so it's loud in logs/monitors.
    console.error('[stripe-webhook] STRIPE_WEBHOOK_SECRET is not set');
    return new Response('Webhook secret not configured', { status: 500 });
  }

  // Raw body is REQUIRED for signature verification — parsing JSON first breaks
  // the HMAC check.
  const rawBody = await req.text();

  let event: StripeEvent;
  try {
    event = constructWebhookEvent(rawBody, signature, webhookSecrets);
  } catch (err) {
    console.warn('[stripe-webhook] signature verification failed', { err });
    return new Response('Invalid signature', { status: 400 });
  }

  // ACK event types we don't act on, before touching the DB.
  if (!HANDLED_STRIPE_EVENT_TYPES.has(event.type)) {
    return new Response(null, { status: 200 });
  }

  try {
    await db.transaction((tx) => dispatchStripeEvent(tx, event));
    return new Response(null, { status: 200 });
  } catch (err) {
    if (err instanceof PermanentWebhookError) {
      // A retry can't fix it — ACK 200 so Stripe stops redelivering, but log.
      console.error('[stripe-webhook] permanent error, ACKing 200', {
        type: event.type,
        id: event.id,
        err,
      });
      return new Response(null, { status: 200 });
    }
    // Transient / unexpected — 500 so Stripe retries (handlers are idempotent).
    console.error('[stripe-webhook] handler error, returning 500 for retry', {
      type: event.type,
      id: event.id,
      err,
    });
    return new Response('Webhook handler error', { status: 500 });
  }
}
