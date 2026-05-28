/**
 * Unit tests for the storefront subdomain extractor.
 *
 * `extractBrandSlug` (deprecated since DEL-22) was removed alongside this
 * cleanup. `extractStorefrontSlug` remains the canonical extractor.
 *
 * Spec: docs/specs/storefront-host-resolution.md
 */

import { describe, expect, it } from 'vitest';
import { extractHostFromUrl, extractStorefrontSlug } from './storefront-host';

describe('extractStorefrontSlug', () => {
  describe('extraction', () => {
    it('returns the brand-style subdomain on prd', () => {
      expect(extractStorefrontSlug('pizza-express.deliverse.app', 'deliverse.app')).toBe(
        'pizza-express',
      );
    });

    it('returns the tenant-style subdomain on prd', () => {
      expect(extractStorefrontSlug('oomi-kitchen.deliverse.app', 'deliverse.app')).toBe(
        'oomi-kitchen',
      );
    });

    it('returns the subdomain on localhost dev', () => {
      expect(extractStorefrontSlug('pizza-express.localhost:3001', 'localhost:3001')).toBe(
        'pizza-express',
      );
    });

    it('strips port from host before comparing', () => {
      expect(extractStorefrontSlug('pizza-express.deliverse.app:8443', 'deliverse.app')).toBe(
        'pizza-express',
      );
    });

    it('tolerates scheme-prefixed baseDomain', () => {
      expect(extractStorefrontSlug('pizza-express.localhost:3001', 'http://localhost:3001')).toBe(
        'pizza-express',
      );
    });

    it('tolerates trailing slash on baseDomain', () => {
      expect(extractStorefrontSlug('pizza-express.deliverse.app', 'deliverse.app/')).toBe(
        'pizza-express',
      );
    });

    it('lowercases case-insensitively', () => {
      expect(extractStorefrontSlug('Pizza-Express.Deliverse.App', 'deliverse.app')).toBe(
        'pizza-express',
      );
    });
  });

  describe('reserved subdomains', () => {
    it.each(['www', 'admin', 'api', 'app'])('returns null for reserved %s', (sub) => {
      expect(extractStorefrontSlug(`${sub}.deliverse.app`, 'deliverse.app')).toBeNull();
    });
  });

  describe('non-matching hosts', () => {
    it('returns null when host equals baseDomain (no subdomain)', () => {
      expect(extractStorefrontSlug('deliverse.app', 'deliverse.app')).toBeNull();
    });

    it('returns null when host does not end in baseDomain', () => {
      expect(extractStorefrontSlug('pizza-express.example.com', 'deliverse.app')).toBeNull();
    });

    it('returns null for null host', () => {
      expect(extractStorefrontSlug(null, 'deliverse.app')).toBeNull();
    });

    it('returns null for undefined host', () => {
      expect(extractStorefrontSlug(undefined, 'deliverse.app')).toBeNull();
    });

    it('returns null for empty host', () => {
      expect(extractStorefrontSlug('', 'deliverse.app')).toBeNull();
    });

    it('returns null for undefined baseDomain', () => {
      expect(extractStorefrontSlug('pizza-express.deliverse.app', undefined)).toBeNull();
    });
  });
});

describe('extractHostFromUrl', () => {
  it('returns host from prd https URL', () => {
    expect(extractHostFromUrl('https://oomi-kitchen.deliverse.app/checkout')).toBe(
      'oomi-kitchen.deliverse.app',
    );
  });

  it('returns host:port from dev http URL', () => {
    expect(extractHostFromUrl('http://pizza-express.localhost:3001/')).toBe(
      'pizza-express.localhost:3001',
    );
  });

  it('returns host without trailing slash even for root path', () => {
    expect(extractHostFromUrl('https://deliverse.app/')).toBe('deliverse.app');
  });

  it('returns host stripped of query + hash', () => {
    expect(
      extractHostFromUrl('https://pizza-express.deliverse.app/cart?ref=a#x'),
    ).toBe('pizza-express.deliverse.app');
  });

  it('returns null for non-URL input', () => {
    expect(extractHostFromUrl('not a url')).toBeNull();
  });

  it('returns null for relative URL', () => {
    // `new URL('/foo')` throws — relative URLs aren't absolute. Browsers
    // send absolute Referer/Origin values (or no header at all), so this
    // is the right behavior for the resolver/proxy fallback.
    expect(extractHostFromUrl('/cart')).toBeNull();
  });

  it('returns null for null input', () => {
    expect(extractHostFromUrl(null)).toBeNull();
  });

  it('returns null for undefined input', () => {
    expect(extractHostFromUrl(undefined)).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(extractHostFromUrl('')).toBeNull();
  });
});
