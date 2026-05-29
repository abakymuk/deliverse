/**
 * @rp/payments — Stripe Connect onboarding + webhook handlers.
 *
 * Public API:
 *   - ./client         getStripe() lazy singleton
 *   - ./onboarding     createOrReuseConnectAccount, createAccountLink
 *   - ./payment-intent createPaymentIntentForOrder (storefront checkout, DEL-44)
 *   - ./handlers       dispatchStripeEvent + per-type handlers (pure, tx-scoped)
 */

export { getStripe } from './client';
export { PermanentWebhookError } from './errors';
export { createAccountLink, createOrReuseConnectAccount } from './onboarding';
export { createPaymentIntentForOrder } from './payment-intent';
export {
  dispatchStripeEvent,
  handleAccountUpdated,
  handleChargeRefunded,
  handlePaymentIntentSucceeded,
  HANDLED_STRIPE_EVENT_TYPES,
} from './handlers';
