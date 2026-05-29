/**
 * Stripe client — lazy singleton.
 *
 * getStripe() instantiates on FIRST CALL, never at module load. This mirrors
 * @rp/emails' getResend() and deliberately differs from @rp/db's client.ts
 * (which throws at module-init): the Stripe webhook route imports this module,
 * so it lives in the App Router route graph that Next 16's `next build`
 * evaluates with NODE_ENV=production. A throw-at-init client would crash CI's
 * build when STRIPE_SECRET_KEY isn't in the build environment (the key is only
 * needed at request time on the deployed server). Callers MUST invoke
 * getStripe() inside request handlers / server actions, never at module top
 * level.
 */

import Stripe from 'stripe';

// Pinned to the installed SDK's locked API version (stripe@22 →
// 2026-05-27.dahlia). The SDK types `apiVersion` as the exact LatestApiVersion
// literal, so this stays in lockstep with the `stripe` dependency — bump both
// together.
const STRIPE_API_VERSION = '2026-05-27.dahlia';

let stripeInstance: Stripe | undefined;

export function getStripe(): Stripe {
  if (stripeInstance) return stripeInstance;

  const apiKey = process.env.STRIPE_SECRET_KEY;
  if (!apiKey) {
    throw new Error('STRIPE_SECRET_KEY is not set');
  }

  stripeInstance = new Stripe(apiKey, { apiVersion: STRIPE_API_VERSION });
  return stripeInstance;
}
