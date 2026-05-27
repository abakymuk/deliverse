/**
 * Unit tests for the storefront subdomain extractors.
 *
 * `extractBrandSlug` (deprecated; consumed by the BA adapter wrapper) and
 * `extractStorefrontSlug` (new in DEL-20; consumed by the proxy) share the
 * same logic during the DEL-20 → DEL-22 transition — the parameterized
 * describe asserts they remain semantically identical.
 *
 * Spec: docs/specs/storefront-host-resolution.md
 */

import { describe, expect, it } from 'vitest';
import { extractBrandSlug, extractStorefrontSlug } from './storefront-host';

describe.each([
  { label: 'extractBrandSlug', fn: extractBrandSlug },
  { label: 'extractStorefrontSlug', fn: extractStorefrontSlug },
])('$label', ({ fn }) => {
  describe('extraction', () => {
    it('returns the brand-style subdomain on prd', () => {
      expect(fn('pizza-express.deliverse.app', 'deliverse.app')).toBe('pizza-express');
    });

    it('returns the tenant-style subdomain on prd', () => {
      expect(fn('oomi-kitchen.deliverse.app', 'deliverse.app')).toBe('oomi-kitchen');
    });

    it('returns the subdomain on localhost dev', () => {
      expect(fn('pizza-express.localhost:3001', 'localhost:3001')).toBe('pizza-express');
    });

    it('strips port from host before comparing', () => {
      expect(fn('pizza-express.deliverse.app:8443', 'deliverse.app')).toBe('pizza-express');
    });

    it('tolerates scheme-prefixed baseDomain', () => {
      expect(fn('pizza-express.localhost:3001', 'http://localhost:3001')).toBe('pizza-express');
    });

    it('tolerates trailing slash on baseDomain', () => {
      expect(fn('pizza-express.deliverse.app', 'deliverse.app/')).toBe('pizza-express');
    });

    it('lowercases case-insensitively', () => {
      expect(fn('Pizza-Express.Deliverse.App', 'deliverse.app')).toBe('pizza-express');
    });
  });

  describe('reserved subdomains', () => {
    it.each(['www', 'admin', 'api', 'app'])('returns null for reserved %s', (sub) => {
      expect(fn(`${sub}.deliverse.app`, 'deliverse.app')).toBeNull();
    });
  });

  describe('non-matching hosts', () => {
    it('returns null when host equals baseDomain (no subdomain)', () => {
      expect(fn('deliverse.app', 'deliverse.app')).toBeNull();
    });

    it('returns null when host does not end in baseDomain', () => {
      expect(fn('pizza-express.example.com', 'deliverse.app')).toBeNull();
    });

    it('returns null for null host', () => {
      expect(fn(null, 'deliverse.app')).toBeNull();
    });

    it('returns null for undefined host', () => {
      expect(fn(undefined, 'deliverse.app')).toBeNull();
    });

    it('returns null for empty host', () => {
      expect(fn('', 'deliverse.app')).toBeNull();
    });

    it('returns null for undefined baseDomain', () => {
      expect(fn('pizza-express.deliverse.app', undefined)).toBeNull();
    });
  });
});

describe('symmetry: extractBrandSlug and extractStorefrontSlug return the same value', () => {
  const cases: Array<{ host: string | null; baseDomain: string | undefined }> = [
    { host: 'pizza-express.deliverse.app', baseDomain: 'deliverse.app' },
    { host: 'oomi-kitchen.staging.deliverse.app', baseDomain: 'staging.deliverse.app' },
    { host: 'admin.deliverse.app', baseDomain: 'deliverse.app' },
    { host: 'deliverse.app', baseDomain: 'deliverse.app' },
    { host: null, baseDomain: 'deliverse.app' },
  ];

  it.each(cases)('host=$host baseDomain=$baseDomain → both extractors agree', ({ host, baseDomain }) => {
    expect(extractStorefrontSlug(host, baseDomain)).toBe(extractBrandSlug(host, baseDomain));
  });
});
