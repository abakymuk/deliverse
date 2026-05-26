/**
 * Package-local brand-context resolver for transactional email handlers.
 *
 * Mirrors `packages/auth-core/src/storefront-tenant-resolver.ts` but adds
 * the tenant-ownership defense-in-depth check: the resolver verifies that
 * the brand actually belongs to the tenant the event claims, rejecting any
 * forged or buggy event that pairs a brand with the wrong tenant.
 *
 * Per ADR-0009 §10:
 *   - Uses `@rp/db` directly. NOT the storefront app's `getBrandContext`
 *     (workspace dep direction; React `cache()` makes no sense here).
 *   - Verifies `brand.tenantId === eventTenantId`.
 *   - Throws `BrandResolutionError` on miss/mismatch so Inngest retries via
 *     its default policy (4 retries exponential).
 */

import { type Brand, type Tenant, brands, db, tenants } from '@rp/db';
import { and, eq, isNull } from 'drizzle-orm';

export class BrandResolutionError extends Error {
  constructor(reason: string) {
    super(`emails: brand resolution failed — ${reason}`);
    this.name = 'BrandResolutionError';
  }
}

export type EmailBrandContext = {
  brand: Brand;
  tenant: Tenant;
};

export async function resolveEmailBrandContext(
  brandSlug: string,
  tenantId: string,
): Promise<EmailBrandContext> {
  const result = await db
    .select({ brand: brands, tenant: tenants })
    .from(brands)
    .innerJoin(tenants, eq(brands.tenantId, tenants.id))
    .where(
      and(
        eq(brands.slug, brandSlug),
        isNull(brands.deletedAt),
        isNull(tenants.deletedAt),
        eq(tenants.status, 'active'),
        eq(brands.isActive, true),
      ),
    )
    .limit(1);

  const row = result[0];
  if (!row) {
    throw new BrandResolutionError(`no active brand for slug=${brandSlug} tenantId=${tenantId}`);
  }
  if (row.brand.tenantId !== tenantId) {
    throw new BrandResolutionError(
      `tenant ownership mismatch — brand "${brandSlug}" belongs to tenant ${row.brand.tenantId}, event claims ${tenantId}`,
    );
  }
  return row;
}
