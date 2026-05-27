/**
 * Unit tests for `safeNextPath` — the DEL-17 redirect path sanitizer.
 *
 * Spec: removing `callbackURL` from `signIn.email` makes the form the sole
 * owner of post-login navigation, so `next` flowing from `searchParams` into
 * `router.push` must be safe against open-redirect / path-shaping vectors.
 */

import { describe, expect, it } from 'vitest';
import { safeNextPath } from './safe-next-path';

const FALLBACK = '/dashboard';

describe('safeNextPath', () => {
  describe('accepts safe relative paths', () => {
    it('returns a simple path unchanged', () => {
      expect(safeNextPath('/dashboard', FALLBACK)).toBe('/dashboard');
    });

    it('preserves query string', () => {
      expect(safeNextPath('/dashboard/tenants?foo=bar&baz=qux', FALLBACK)).toBe(
        '/dashboard/tenants?foo=bar&baz=qux',
      );
    });

    it('preserves hash fragment', () => {
      expect(safeNextPath('/account#section', FALLBACK)).toBe('/account#section');
    });
  });

  describe('rejects empty / nullish input', () => {
    it('returns fallback for null', () => {
      expect(safeNextPath(null, FALLBACK)).toBe(FALLBACK);
    });

    it('returns fallback for empty string', () => {
      expect(safeNextPath('', FALLBACK)).toBe(FALLBACK);
    });
  });

  describe('rejects off-origin targets', () => {
    it('rejects protocol-relative URL (//host)', () => {
      expect(safeNextPath('//evil.com', FALLBACK)).toBe(FALLBACK);
    });

    it('rejects https://evil.com', () => {
      expect(safeNextPath('https://evil.com', FALLBACK)).toBe(FALLBACK);
    });

    it('rejects http://evil.com', () => {
      expect(safeNextPath('http://evil.com', FALLBACK)).toBe(FALLBACK);
    });

    it('rejects javascript: scheme', () => {
      expect(safeNextPath('javascript:alert(1)', FALLBACK)).toBe(FALLBACK);
    });
  });

  describe('rejects backslash injection', () => {
    it('rejects raw backslash in path', () => {
      expect(safeNextPath('/\\evil.com', FALLBACK)).toBe(FALLBACK);
    });

    it('rejects URL-encoded backslash (%5c)', () => {
      expect(safeNextPath('/%5cevil.com', FALLBACK)).toBe(FALLBACK);
    });

    it('rejects URL-encoded backslash uppercase (%5C)', () => {
      expect(safeNextPath('/%5Cevil.com', FALLBACK)).toBe(FALLBACK);
    });
  });

  describe('rejects whitespace-padded input', () => {
    it('rejects trailing whitespace', () => {
      expect(safeNextPath('/dashboard ', FALLBACK)).toBe(FALLBACK);
    });

    it('rejects leading whitespace', () => {
      expect(safeNextPath(' /dashboard', FALLBACK)).toBe(FALLBACK);
    });
  });
});
