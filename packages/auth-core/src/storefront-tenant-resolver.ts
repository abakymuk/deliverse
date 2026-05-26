/**
 * Package-local brand resolver for the storefront BA adapter wrapper.
 *
 * Mirrors `apps/storefront/src/lib/tenant-resolution.ts:getBrandContext` but
 * **without** React `cache()` — packages stay UI-framework-free per
 * ADR-0009's dep-direction principle.
 *
 * Spec: docs/specs/storefront-tenant-scoping.md §8.
 */

import { brands, db, tenants } from '@rp/db';
import type { Brand, Tenant } from '@rp/db';
import { and, eq, isNull } from 'drizzle-orm';

export type BrandContext = {
  brand: Brand;
  tenant: Tenant;
};

export async function resolveBrandBySlug(slug: string): Promise<BrandContext | null> {
  const result = await db
    .select({ brand: brands, tenant: tenants })
    .from(brands)
    .innerJoin(tenants, eq(brands.tenantId, tenants.id))
    .where(
      and(
        eq(brands.slug, slug),
        isNull(brands.deletedAt),
        isNull(tenants.deletedAt),
        eq(tenants.status, 'active'),
        eq(brands.isActive, true),
      ),
    )
    .limit(1);

  return result[0] ?? null;
}
