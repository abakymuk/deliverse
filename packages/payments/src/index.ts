/**
 * @rp/payments — Stripe Connect onboarding + webhook handlers.
 *
 * Public API:
 *   - ./client      getStripe() lazy singleton
 *   - ./onboarding  createOrReuseConnectAccount, createAccountLink
 *   - ./handlers    dispatchStripeEvent + per-type handlers (pure, tx-scoped)
 *
 * Step 4 adds the refund (charge.refunded) handler; capture
 * (payment_intent.succeeded) is wired here in step 3.
 */

export { getStripe } from './client';
export { PermanentWebhookError } from './errors';
export { createAccountLink, createOrReuseConnectAccount } from './onboarding';
export {
  dispatchStripeEvent,
  handleAccountUpdated,
  handleChargeRefunded,
  handlePaymentIntentSucceeded,
  HANDLED_STRIPE_EVENT_TYPES,
} from './handlers';
