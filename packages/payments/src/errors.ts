/**
 * Webhook error taxonomy for ACK discipline.
 *
 * The Stripe webhook route distinguishes two failure classes:
 *   - PermanentWebhookError → log + return 200. A retry can't fix it (missing /
 *     invalid metadata, unknown tenant). Returning a non-2xx would make Stripe
 *     retry for ~3 days and eventually disable the endpoint.
 *   - anything else (DB blip, unexpected bug) → 500. Stripe retries, and row /
 *     event idempotency (UNIQUE(provider, external_id) + outbox key) makes a
 *     retry safe.
 */
export class PermanentWebhookError extends Error {
  constructor(message: string) {
    super(`payments: ${message}`);
    this.name = 'PermanentWebhookError';
  }
}
