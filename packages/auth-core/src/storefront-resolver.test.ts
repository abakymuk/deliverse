/**
 * Unit tests for the storefront-resolver row mapper.
 *
 * Narrow by design — verifies `primaryBrandId: null` → `brandId: undefined`
 * and the brand-row case. The actual DB query behavior (filters, joins,
 * limit) is covered by e2e (apps/storefront/tests/e2e/storefront-host-resolution.spec.ts).
 *
 * Spec: docs/specs/storefront-host-resolution.md
 */

import { describe, expect, it, vi } from 'vitest';

// Stub @rp/db so the eager `DATABASE_URL` check in packages/db/src/client.ts
// doesn't run during this mock-only test suite. The unit tests below only
// touch the pure `rowToStorefrontContext` mapper; the `db` / `storefronts` /
// `tenants` imports in storefront-resolver.ts are never dereferenced here.
vi.mock('@rp/db', () => ({
  db: {},
  storefronts: {},
  tenants: {},
}));

import { rowToStorefrontContext } from './storefront-resolver';

const TENANT_ID = '11111111-1111-4111-9111-111111111111';
const STOREFRONT_ID = '22222222-2222-4222-9222-222222222222';
const BRAND_ID = '33333333-3333-4333-9333-333333333333';

describe('rowToStorefrontContext', () => {
  it('maps a brand-type row to a context with brandId set', () => {
    expect(
      rowToStorefrontContext({
        storefrontId: STOREFRONT_ID,
        storefrontType: 'brand',
        storefrontName: 'Pizza Express',
        tenantId: TENANT_ID,
        primaryBrandId: BRAND_ID,
      }),
    ).toEqual({
      storefrontId: STOREFRONT_ID,
      storefrontType: 'brand',
      storefrontName: 'Pizza Express',
      tenantId: TENANT_ID,
      brandId: BRAND_ID,
    });
  });

  it('maps a tenant-type row with NULL primaryBrandId to brandId undefined (not null)', () => {
    const result = rowToStorefrontContext({
      storefrontId: STOREFRONT_ID,
      storefrontType: 'tenant',
      storefrontName: 'OOMI Kitchen',
      tenantId: TENANT_ID,
      primaryBrandId: null,
    });

    expect(result).toEqual({
      storefrontId: STOREFRONT_ID,
      storefrontType: 'tenant',
      storefrontName: 'OOMI Kitchen',
      tenantId: TENANT_ID,
      brandId: undefined,
    });
    // Explicit: must be `undefined`, never `null` — the public `brandId?: string`
    // contract should never carry a `null` payload.
    expect(result.brandId).toBeUndefined();
  });
});
