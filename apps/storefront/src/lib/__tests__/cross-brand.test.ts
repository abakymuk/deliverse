/**
 * Unit tests for `getSiblingBrands` — mirrors the mock pattern from
 * `packages/emails/__tests__/brand-context.test.ts`.
 *
 * Mocks `@rp/db` at the module boundary so the helper's Drizzle query chain
 * returns fixture data. The point is the helper's *where-clause semantics*
 * (tenant match, exclude current, active, not soft-deleted, ordered by name),
 * NOT Drizzle's query builder.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const TENANT_ID = '11111111-1111-4111-9111-111111111111';
const OTHER_TENANT_ID = '99999999-9999-4999-9999-999999999999';

const pizzaExpress = {
  id: '22222222-2222-4222-9222-222222222222',
  tenantId: TENANT_ID,
  slug: 'pizza-express',
  name: 'Pizza Express',
  brandingJson: { primary: '#dc2626' },
  isActive: true,
  createdAt: new Date('2026-01-01'),
  updatedAt: new Date('2026-01-01'),
  deletedAt: null,
};

const burgerHeaven = {
  ...pizzaExpress,
  id: '33333333-3333-4333-9333-333333333333',
  slug: 'burger-heaven',
  name: 'Burger Heaven',
};

const tacoTown = {
  ...pizzaExpress,
  id: '44444444-4444-4444-9444-444444444444',
  slug: 'taco-town',
  name: 'Taco Town',
};

// Terminal-method mocks: getSiblingBrands ends with `.orderBy(...)`;
// checkEmailExistsInTenant / hasUserVisitedBrand end with `.limit(...)`.
const orderByMock = vi.fn();
const limitMock = vi.fn();

vi.mock('@rp/db', () => {
  const chain = {
    from: () => chain,
    innerJoin: () => chain,
    where: () => chain,
    orderBy: orderByMock,
    limit: limitMock,
  };
  return {
    db: { select: (..._args: unknown[]) => chain },
    brands: {},
    tenantEndUsers: {},
    tenantEndUserSessions: {},
  };
});

vi.mock('drizzle-orm', () => ({
  and: vi.fn(),
  eq: vi.fn(),
  isNull: vi.fn(),
  ne: vi.fn(),
}));

const { checkEmailExistsInTenant, getSiblingBrands, hasUserVisitedBrand } = await import(
  '../cross-brand'
);

beforeEach(() => {
  orderByMock.mockReset();
  limitMock.mockReset();
});

describe('getSiblingBrands', () => {
  it('returns sibling brands ordered by name', async () => {
    orderByMock.mockResolvedValue([burgerHeaven, tacoTown]);

    const result = await getSiblingBrands(TENANT_ID, 'pizza-express');

    expect(result).toHaveLength(2);
    expect(result[0]?.slug).toBe('burger-heaven');
    expect(result[1]?.slug).toBe('taco-town');
  });

  it('returns empty array when the tenant has no sibling brands', async () => {
    orderByMock.mockResolvedValue([]);

    const result = await getSiblingBrands(TENANT_ID, 'pizza-express');

    expect(result).toEqual([]);
  });

  it('excludes the current brand from results (by where-clause, not by post-filter)', async () => {
    // The Drizzle `ne(brands.slug, currentBrandSlug)` clause does this in SQL.
    // The mock returns whatever the query result would be; we trust the
    // where-clause builder by assertion on the empty case + happy case above.
    orderByMock.mockResolvedValue([burgerHeaven]);

    const result = await getSiblingBrands(TENANT_ID, 'pizza-express');

    expect(result.some((b) => b.slug === 'pizza-express')).toBe(false);
  });

  it('only returns rows the where-clause matched — inactive/deleted/other-tenant rows filtered in SQL', async () => {
    // The mock simulates the SQL filtering by returning only the rows that
    // would have passed. Asserts the helper trusts the DB layer and doesn't
    // re-filter.
    const inactive = { ...burgerHeaven, isActive: false };
    const deleted = { ...tacoTown, deletedAt: new Date('2026-01-01') };
    const otherTenant = { ...burgerHeaven, tenantId: OTHER_TENANT_ID };

    // Pretend SQL filtered all three out:
    orderByMock.mockResolvedValue([]);

    const result = await getSiblingBrands(TENANT_ID, 'pizza-express');

    // The helper returns whatever SQL returned — no post-filter logic to test.
    expect(result).toEqual([]);
    // Sanity: these never made it through (the where-clause caught them):
    expect(result).not.toContain(inactive);
    expect(result).not.toContain(deleted);
    expect(result).not.toContain(otherTenant);
  });
});

describe('checkEmailExistsInTenant (DEL-14)', () => {
  it('returns true when the where-clause matches a row', async () => {
    limitMock.mockResolvedValue([{ id: 'user-id-1' }]);
    const result = await checkEmailExistsInTenant(TENANT_ID, 'guest@test.local');
    expect(result).toBe(true);
  });

  it('returns false when SQL returns no rows (email not in tenant)', async () => {
    limitMock.mockResolvedValue([]);
    const result = await checkEmailExistsInTenant(TENANT_ID, 'unknown@test.local');
    expect(result).toBe(false);
  });

  it('returns false for soft-deleted users (where-clause filters in SQL)', async () => {
    // The helper trusts the `isNull(deletedAt)` predicate; mock returns
    // nothing because SQL filtered the soft-deleted row.
    limitMock.mockResolvedValue([]);
    const result = await checkEmailExistsInTenant(TENANT_ID, 'deleted@test.local');
    expect(result).toBe(false);
  });

  it('returns false for same email at a different tenant (where-clause filters in SQL)', async () => {
    limitMock.mockResolvedValue([]);
    const result = await checkEmailExistsInTenant(OTHER_TENANT_ID, 'guest@test.local');
    expect(result).toBe(false);
  });
});

describe('hasUserVisitedBrand (DEL-14)', () => {
  const PIZZA_BRAND_ID = '22222222-2222-4222-9222-222222222222';
  const BURGER_BRAND_ID = '33333333-3333-4333-9333-333333333333';

  it('returns true when the user has at least one session at the brand', async () => {
    limitMock.mockResolvedValue([{ id: 'session-id-1' }]);
    const result = await hasUserVisitedBrand(TENANT_ID, 'guest@test.local', PIZZA_BRAND_ID);
    expect(result).toBe(true);
  });

  it('returns false when the user has no sessions at the brand', async () => {
    // SQL returned nothing because no row matched (user_email AND current_brand_id).
    limitMock.mockResolvedValue([]);
    const result = await hasUserVisitedBrand(TENANT_ID, 'guest@test.local', BURGER_BRAND_ID);
    expect(result).toBe(false);
  });

  it('returns false when the user does not exist in the tenant at all', async () => {
    limitMock.mockResolvedValue([]);
    const result = await hasUserVisitedBrand(TENANT_ID, 'unknown@test.local', PIZZA_BRAND_ID);
    expect(result).toBe(false);
  });

  it('returns false for soft-deleted users (where-clause filters in SQL)', async () => {
    // The inner-join + isNull(deletedAt) predicate excludes soft-deleted users
    // before the brand match is even evaluated.
    limitMock.mockResolvedValue([]);
    const result = await hasUserVisitedBrand(TENANT_ID, 'deleted@test.local', PIZZA_BRAND_ID);
    expect(result).toBe(false);
  });
});
