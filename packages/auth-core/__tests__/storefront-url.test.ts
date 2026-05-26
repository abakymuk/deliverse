/**
 * Unit tests for `rewriteStorefrontEmailUrl` — the DEL-15 storefront BA
 * reset-URL origin rewriter.
 *
 * Spec: docs/specs/del-15-storefront-baseurl.md §Acceptance Criteria.
 */

import { describe, expect, it } from 'vitest';
import { rewriteStorefrontEmailUrl } from '../src/storefront-url';

const BA_DEV_URL =
  'http://localhost:3000/reset-password/abc123def456?callbackURL=%2Freset-password';
const BA_PRD_URL =
  'https://admin.deliverse.app/reset-password/abc123def456?callbackURL=%2Freset-password';

describe('rewriteStorefrontEmailUrl', () => {
  describe('dev — http + localhost:3001', () => {
    it('rewrites origin to pizza-express subdomain', () => {
      const result = rewriteStorefrontEmailUrl({
        originalUrl: BA_DEV_URL,
        brandSlug: 'pizza-express',
        baseDomain: 'localhost:3001',
        proto: 'http',
      });
      expect(result).toBe(
        'http://pizza-express.localhost:3001/reset-password/abc123def456?callbackURL=%2Freset-password',
      );
    });

    it('rewrites origin to burger-heaven subdomain (multi-tenant)', () => {
      const result = rewriteStorefrontEmailUrl({
        originalUrl: BA_DEV_URL,
        brandSlug: 'burger-heaven',
        baseDomain: 'localhost:3001',
        proto: 'http',
      });
      expect(result).toBe(
        'http://burger-heaven.localhost:3001/reset-password/abc123def456?callbackURL=%2Freset-password',
      );
    });
  });

  describe('stg — https + staging.deliverse.app', () => {
    it('rewrites origin to pizza-express.staging subdomain', () => {
      const result = rewriteStorefrontEmailUrl({
        originalUrl: BA_PRD_URL,
        brandSlug: 'pizza-express',
        baseDomain: 'staging.deliverse.app',
        proto: 'https',
      });
      expect(result).toBe(
        'https://pizza-express.staging.deliverse.app/reset-password/abc123def456?callbackURL=%2Freset-password',
      );
    });
  });

  describe('prd — https + deliverse.app', () => {
    it('rewrites origin to pizza-express.deliverse.app', () => {
      const result = rewriteStorefrontEmailUrl({
        originalUrl: BA_PRD_URL,
        brandSlug: 'pizza-express',
        baseDomain: 'deliverse.app',
        proto: 'https',
      });
      expect(result).toBe(
        'https://pizza-express.deliverse.app/reset-password/abc123def456?callbackURL=%2Freset-password',
      );
    });

    it('rewrites origin to burger-heaven.deliverse.app (multi-tenant)', () => {
      const result = rewriteStorefrontEmailUrl({
        originalUrl: BA_PRD_URL,
        brandSlug: 'burger-heaven',
        baseDomain: 'deliverse.app',
        proto: 'https',
      });
      expect(result).toBe(
        'https://burger-heaven.deliverse.app/reset-password/abc123def456?callbackURL=%2Freset-password',
      );
    });
  });

  describe('path + query preservation', () => {
    it('keeps the verification token in the path', () => {
      const result = rewriteStorefrontEmailUrl({
        originalUrl:
          'http://localhost:3000/reset-password/UNIQUE-TOKEN-VALUE?callbackURL=%2Freset-password',
        brandSlug: 'pizza-express',
        baseDomain: 'localhost:3001',
        proto: 'http',
      });
      expect(new URL(result).pathname).toBe('/reset-password/UNIQUE-TOKEN-VALUE');
    });

    it('keeps the callbackURL query value (already URI-encoded)', () => {
      const result = rewriteStorefrontEmailUrl({
        originalUrl: 'http://localhost:3000/reset-password/abc?callbackURL=%2Freset-password',
        brandSlug: 'pizza-express',
        baseDomain: 'localhost:3001',
        proto: 'http',
      });
      expect(new URL(result).searchParams.get('callbackURL')).toBe('/reset-password');
    });

    it('preserves arbitrary additional query params (forward-compat)', () => {
      const result = rewriteStorefrontEmailUrl({
        originalUrl: 'http://localhost:3000/reset-password/abc?callbackURL=%2Fx&extra=42',
        brandSlug: 'pizza-express',
        baseDomain: 'localhost:3001',
        proto: 'http',
      });
      const parsed = new URL(result);
      expect(parsed.searchParams.get('callbackURL')).toBe('/x');
      expect(parsed.searchParams.get('extra')).toBe('42');
    });
  });

  describe('baseDomain parsing tolerance', () => {
    it('strips an http:// scheme prefix from baseDomain (Doppler historical)', () => {
      const result = rewriteStorefrontEmailUrl({
        originalUrl: BA_DEV_URL,
        brandSlug: 'pizza-express',
        baseDomain: 'http://localhost:3001',
        proto: 'http',
      });
      expect(new URL(result).host).toBe('pizza-express.localhost:3001');
    });

    it('strips an https:// scheme prefix from baseDomain', () => {
      const result = rewriteStorefrontEmailUrl({
        originalUrl: BA_PRD_URL,
        brandSlug: 'pizza-express',
        baseDomain: 'https://deliverse.app',
        proto: 'https',
      });
      expect(new URL(result).host).toBe('pizza-express.deliverse.app');
    });

    it('strips a trailing path/slash from baseDomain', () => {
      const result = rewriteStorefrontEmailUrl({
        originalUrl: BA_PRD_URL,
        brandSlug: 'pizza-express',
        baseDomain: 'deliverse.app/',
        proto: 'https',
      });
      expect(new URL(result).host).toBe('pizza-express.deliverse.app');
    });

    it('lowercases the baseDomain', () => {
      const result = rewriteStorefrontEmailUrl({
        originalUrl: BA_PRD_URL,
        brandSlug: 'pizza-express',
        baseDomain: 'Deliverse.App',
        proto: 'https',
      });
      expect(new URL(result).host).toBe('pizza-express.deliverse.app');
    });
  });
});
