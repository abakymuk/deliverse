/**
 * parseWebhookSecrets / constructWebhookEvent unit tests.
 *
 * No DB needed: ./webhook → ./client imports only the `stripe` SDK, and Stripe's
 * HMAC signature verification is purely local (no network; any API key lets the
 * client instantiate). We set a dummy STRIPE_SECRET_KEY, then sign payloads with
 * Stripe's own generateTestHeaderString so the multi-secret selection is proven
 * against REAL signatures rather than a mock.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { getStripe } from '../src/client';
import { constructWebhookEvent, parseWebhookSecrets } from '../src/webhook';

beforeAll(() => {
  process.env.STRIPE_SECRET_KEY ||= 'sk_test_dummy_for_hmac';
});

function sign(payload: string, secret: string): string {
  return getStripe().webhooks.generateTestHeaderString({ payload, secret });
}

describe('parseWebhookSecrets', () => {
  it('splits comma-separated values, trimming and dropping blanks', () => {
    expect(parseWebhookSecrets('whsec_a, whsec_b ,,  whsec_c ')).toEqual([
      'whsec_a',
      'whsec_b',
      'whsec_c',
    ]);
  });

  it('returns an empty array for undefined or blank input', () => {
    expect(parseWebhookSecrets(undefined)).toEqual([]);
    expect(parseWebhookSecrets('   ')).toEqual([]);
    expect(parseWebhookSecrets(',')).toEqual([]);
  });

  it('handles a single secret unchanged', () => {
    expect(parseWebhookSecrets('whsec_only')).toEqual(['whsec_only']);
  });
});

describe('constructWebhookEvent', () => {
  const payload = JSON.stringify({
    id: 'evt_test',
    object: 'event',
    type: 'account.updated',
    data: { object: { id: 'acct_test', object: 'account' } },
  });

  it('verifies against a single matching secret', () => {
    const sig = sign(payload, 'whsec_solo');
    expect(constructWebhookEvent(payload, sig, ['whsec_solo']).id).toBe('evt_test');
  });

  it('verifies when the matching secret is first in the list', () => {
    const sig = sign(payload, 'whsec_first');
    expect(constructWebhookEvent(payload, sig, ['whsec_first', 'whsec_second']).id).toBe(
      'evt_test',
    );
  });

  it('verifies when the matching secret is NOT first (separate connect endpoint)', () => {
    const sig = sign(payload, 'whsec_second');
    expect(constructWebhookEvent(payload, sig, ['whsec_first', 'whsec_second']).id).toBe(
      'evt_test',
    );
  });

  it('throws when no configured secret verifies the signature', () => {
    const sig = sign(payload, 'whsec_unknown');
    expect(() => constructWebhookEvent(payload, sig, ['whsec_a', 'whsec_b'])).toThrow();
  });

  it('throws when no secrets are configured', () => {
    const sig = sign(payload, 'whsec_x');
    expect(() => constructWebhookEvent(payload, sig, [])).toThrow(/no signing secrets/);
  });
});
