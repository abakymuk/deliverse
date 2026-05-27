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

import {
  type Brand,
  type Storefront,
  type Tenant,
  brands,
  db,
  storefronts,
  tenants,
} from '@rp/db';
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

// ── Tenant-mode (food-hall) email context — DEL-22 ─────────────────────────
//
// Tenant-host emails (food-hall mode per ADR-0012) have no `brand` context.
// Email branding falls back to the storefront's own `branding_json` +
// `tenants.name` / `tenants.logo` as the source of truth. This resolver
// mirrors `resolveEmailBrandContext`'s cross-tenant defense (SQL-side
// `eq(storefronts.tenantId, tenantId)` + post-read mismatch check).

export type EmailStorefrontContext = {
  storefront: Storefront;
  tenant: Tenant;
};

export async function resolveTenantStorefrontEmailContext(
  storefrontId: string,
  tenantId: string,
): Promise<EmailStorefrontContext> {
  const result = await db
    .select({ storefront: storefronts, tenant: tenants })
    .from(storefronts)
    .innerJoin(tenants, eq(storefronts.tenantId, tenants.id))
    .where(
      and(
        eq(storefronts.id, storefrontId),
        // Belt-and-braces: cross-tenant defense in SQL, not just post-read.
        eq(storefronts.tenantId, tenantId),
        isNull(storefronts.deletedAt),
        eq(storefronts.isActive, true),
        isNull(tenants.deletedAt),
        eq(tenants.status, 'active'),
      ),
    )
    .limit(1);

  const row = result[0];
  if (!row) {
    throw new BrandResolutionError(
      `no active storefront for storefrontId=${storefrontId} tenantId=${tenantId}`,
    );
  }
  // SQL-side guard already enforces ownership; the post-read check is
  // symmetric with `resolveEmailBrandContext` and would surface a clearer
  // error if the SQL guard were ever removed.
  if (row.storefront.tenantId !== tenantId) {
    throw new BrandResolutionError(
      `tenant ownership mismatch — storefront ${storefrontId} belongs to tenant ${row.storefront.tenantId}, event claims ${tenantId}`,
    );
  }
  return row;
}
