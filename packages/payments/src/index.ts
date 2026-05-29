/**
 * @rp/payments — Stripe Connect onboarding + webhook handlers.
 *
 * Public API:
 *   - ./client      getStripe() lazy singleton
 *   - ./onboarding  createOrReuseConnectAccount, createAccountLink
 *   - ./handlers    dispatchStripeEvent + per-type handlers (pure, tx-scoped)
 *
 * Steps 3-4 add capture (payment_intent.succeeded) and refund (charge.refunded)
 * handlers that persist payments/refunds rows and emit @rp/events.
 */

export { getStripe } from './client';
export { PermanentWebhookError } from './errors';
export { createAccountLink, createOrReuseConnectAccount } from './onboarding';
export {
  dispatchStripeEvent,
  handleAccountUpdated,
  HANDLED_STRIPE_EVENT_TYPES,
} from './handlers';
