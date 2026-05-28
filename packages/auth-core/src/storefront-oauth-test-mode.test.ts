/**
 * Unit tests for the storefront BA Google OAuth test-mode helpers.
 *
 * Narrow by design — verifies the pure encode/decode round-trip + the
 * `testModeGoogleHooks` shape. The full DEL-12 cross-tenant invariant
 * lives in the storefront e2e
 * (`apps/storefront/tests/e2e/storefront-tenant-scoping.spec.ts:243`).
 *
 * Spec: docs/specs/del-12-oauth-e2e.md.
 */

import { describe, expect, it } from 'vitest';
import {
  decodeFakeGoogleIdToken,
  encodeFakeGoogleIdToken,
  testModeGoogleHooks,
} from './storefront-oauth-test-mode';

const CLAIMS = {
  uid: 'fake-uid-12345',
  email: 'cross-tenant-oauth@example.com',
  emailVerified: true,
  name: 'OAuth Test User',
};

describe('encodeFakeGoogleIdToken / decodeFakeGoogleIdToken', () => {
  it('round-trips a full claims payload', () => {
    const token = encodeFakeGoogleIdToken(CLAIMS);
    expect(token.startsWith('fake-google-id-')).toBe(true);
    expect(decodeFakeGoogleIdToken(token)).toEqual(CLAIMS);
  });

  it('rejects a token without the recognisable prefix', () => {
    expect(decodeFakeGoogleIdToken('eyJhbGciOiJSUzI1NiI...')).toBeNull();
  });

  it('rejects a token with the prefix but garbage payload', () => {
    expect(decodeFakeGoogleIdToken('fake-google-id-not-base64!@#')).toBeNull();
  });

  it('rejects a token with the prefix + valid base64 but non-claims JSON', () => {
    const garbage = Buffer.from(JSON.stringify({ foo: 'bar' }), 'utf8').toString(
      'base64url',
    );
    expect(decodeFakeGoogleIdToken(`fake-google-id-${garbage}`)).toBeNull();
  });

  it('rejects an empty string', () => {
    expect(decodeFakeGoogleIdToken('')).toBeNull();
  });

  it('handles unicode in name field', () => {
    const claims = { ...CLAIMS, name: 'Ümlaut 名前' };
    const token = encodeFakeGoogleIdToken(claims);
    expect(decodeFakeGoogleIdToken(token)).toEqual(claims);
  });
});

describe('testModeGoogleHooks', () => {
  describe('verifyIdToken', () => {
    it('returns true for a valid fake token', async () => {
      const token = encodeFakeGoogleIdToken(CLAIMS);
      expect(await testModeGoogleHooks.verifyIdToken(token)).toBe(true);
    });

    it('returns false for a non-fake token (real Google JWT shape)', async () => {
      expect(
        await testModeGoogleHooks.verifyIdToken('eyJhbGciOiJSUzI1NiIsImtpZCI6...'),
      ).toBe(false);
    });

    it('returns false for empty string', async () => {
      expect(await testModeGoogleHooks.verifyIdToken('')).toBe(false);
    });

    it('ignores nonce parameter (consistent with BA contract)', async () => {
      // BA passes nonce as the second arg per
      // `@better-auth/core/dist/social-providers/google.mjs:63`. Our
      // implementation ignores it — fake tokens don't carry a nonce.
      const token = encodeFakeGoogleIdToken(CLAIMS);
      expect(await testModeGoogleHooks.verifyIdToken(token, 'some-nonce')).toBe(
        true,
      );
      expect(
        await testModeGoogleHooks.verifyIdToken('not-a-fake', 'some-nonce'),
      ).toBe(false);
    });
  });

  describe('getUserInfo', () => {
    it('decodes claims and returns BA-shaped user payload', async () => {
      const token = encodeFakeGoogleIdToken(CLAIMS);
      const result = await testModeGoogleHooks.getUserInfo({ idToken: token });
      expect(result).toEqual({
        user: {
          id: CLAIMS.uid,
          email: CLAIMS.email,
          emailVerified: CLAIMS.emailVerified,
          name: CLAIMS.name,
          image: undefined,
        },
        data: {
          sub: CLAIMS.uid,
          email: CLAIMS.email,
          email_verified: CLAIMS.emailVerified,
          name: CLAIMS.name,
        },
      });
    });

    it('returns null when idToken is missing', async () => {
      expect(
        await testModeGoogleHooks.getUserInfo({ accessToken: 'whatever' }),
      ).toBeNull();
    });

    it('returns null for a non-fake idToken', async () => {
      expect(
        await testModeGoogleHooks.getUserInfo({ idToken: 'eyJhbGciOi...' }),
      ).toBeNull();
    });
  });
});
