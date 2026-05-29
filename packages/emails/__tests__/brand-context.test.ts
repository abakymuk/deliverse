/**
 * Unit tests for `resolveEmailBrandContext` — the package-local brand
 * resolver with the defense-in-depth tenant-ownership check.
 *
 * Mocks `@rp/db` at the module boundary so the resolver's query chain
 * returns fixture data. The point of these tests is the resolver's logic
 * (tenant-ownership check, missing-row behavior), NOT Drizzle's query
 * builder.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const TENANT_ID = '11111111-1111-4111-9111-111111111111';
const OTHER_TENANT_ID = '99999999-9999-4999-9999-999999999999';
const BRAND_ID = '22222222-2222-4222-9222-222222222222';
const STOREFRONT_ID = '33333333-3333-4333-9333-333333333333';

const tenantFixture = {
  id: TENANT_ID,
  slug: 'hospitality-group',
  name: 'Hospitality Group',
  logo: null,
  status: 'active' as const,
  metadata: null,
  stripeAccountId: null,
  stripeChargesEnabled: false,
  createdAt: new Date('2026-01-01'),
  updatedAt: new Date('2026-01-01'),
  deletedAt: null,
};

const brandFixture = {
  id: BRAND_ID,
  tenantId: TENANT_ID,
  slug: 'pizza-express',
  name: 'Pizza Express',
  brandingJson: { primary: '#dc2626' },
  isActive: true,
  createdAt: new Date('2026-01-01'),
  updatedAt: new Date('2026-01-01'),
  deletedAt: null,
};

// `limitMock` is what the test controls; the rest of the chain just
// returns the chain object so `.from(...).innerJoin(...).where(...).limit(...)`
// resolves to whatever `limitMock` returns.
const limitMock = vi.fn();

vi.mock('@rp/db', () => {
  const chain = {
    from: () => chain,
    innerJoin: () => chain,
    where: () => chain,
    limit: limitMock,
  };
  return {
    db: { select: () => chain },
    brands: {},
    tenants: {},
    storefronts: {},
  };
});

vi.mock('drizzle-orm', () => ({
  and: vi.fn(),
  eq: vi.fn(),
  isNull: vi.fn(),
}));

const { resolveEmailBrandContext, resolveTenantStorefrontEmailContext, BrandResolutionError } =
  await import('../src/brand-context');

beforeEach(() => {
  limitMock.mockReset();
});

describe('resolveEmailBrandContext', () => {
  it('returns { brand, tenant } when the join matches and ownership checks out', async () => {
    limitMock.mockResolvedValue([{ brand: brandFixture, tenant: tenantFixture }]);

    const result = await resolveEmailBrandContext('pizza-express', TENANT_ID);
    expect(result.brand.slug).toBe('pizza-express');
    expect(result.tenant.id).toBe(TENANT_ID);
  });

  it('throws BrandResolutionError when no brand matches the join', async () => {
    limitMock.mockResolvedValue([]);

    await expect(resolveEmailBrandContext('does-not-exist', TENANT_ID)).rejects.toBeInstanceOf(
      BrandResolutionError,
    );
    await expect(resolveEmailBrandContext('does-not-exist', TENANT_ID)).rejects.toThrow(
      /no active brand/,
    );
  });

  it('throws BrandResolutionError when brand.tenantId !== event.tenantId (cross-tenant defense)', async () => {
    const mismatchBrand = { ...brandFixture, tenantId: OTHER_TENANT_ID };
    limitMock.mockResolvedValue([{ brand: mismatchBrand, tenant: tenantFixture }]);

    await expect(resolveEmailBrandContext('pizza-express', TENANT_ID)).rejects.toBeInstanceOf(
      BrandResolutionError,
    );
    await expect(resolveEmailBrandContext('pizza-express', TENANT_ID)).rejects.toThrow(
      /tenant ownership mismatch/,
    );
  });
});

// ── DEL-22 tenant-mode (food-hall) storefront resolver ────────────────────

const storefrontFixture = {
  id: STOREFRONT_ID,
  tenantId: TENANT_ID,
  slug: 'oomi-kitchen-test',
  name: 'OOMI Kitchen Test',
  type: 'tenant' as const,
  primaryBrandId: null,
  brandingJson: { primary: '#16a34a', logo: 'https://cdn.example/oomi.png' },
  isActive: true,
  createdAt: new Date('2026-01-01'),
  updatedAt: new Date('2026-01-01'),
  deletedAt: null,
};

describe('resolveTenantStorefrontEmailContext (DEL-22)', () => {
  it('returns { storefront, tenant } when the join matches and ownership checks out', async () => {
    limitMock.mockResolvedValue([{ storefront: storefrontFixture, tenant: tenantFixture }]);

    const result = await resolveTenantStorefrontEmailContext(STOREFRONT_ID, TENANT_ID);
    expect(result.storefront.slug).toBe('oomi-kitchen-test');
    expect(result.storefront.type).toBe('tenant');
    expect(result.tenant.id).toBe(TENANT_ID);
  });

  it('throws BrandResolutionError when no storefront matches the join', async () => {
    limitMock.mockResolvedValue([]);

    await expect(
      resolveTenantStorefrontEmailContext(STOREFRONT_ID, TENANT_ID),
    ).rejects.toBeInstanceOf(BrandResolutionError);
    await expect(resolveTenantStorefrontEmailContext(STOREFRONT_ID, TENANT_ID)).rejects.toThrow(
      /no active storefront/,
    );
  });

  it('throws BrandResolutionError when storefront.tenantId !== event.tenantId (cross-tenant defense)', async () => {
    // SQL-side `eq(storefronts.tenantId, tenantId)` should prevent this row
    // from being selected at all; but if a future SQL refactor regresses
    // that guard, the post-read check catches the mismatch.
    const mismatch = { ...storefrontFixture, tenantId: OTHER_TENANT_ID };
    limitMock.mockResolvedValue([{ storefront: mismatch, tenant: tenantFixture }]);

    await expect(
      resolveTenantStorefrontEmailContext(STOREFRONT_ID, TENANT_ID),
    ).rejects.toBeInstanceOf(BrandResolutionError);
    await expect(resolveTenantStorefrontEmailContext(STOREFRONT_ID, TENANT_ID)).rejects.toThrow(
      /tenant ownership mismatch/,
    );
  });
});
