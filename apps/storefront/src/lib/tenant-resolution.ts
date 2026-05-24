/**
 * Tenant resolution: subdomain → brand → tenant
 *
 * Storefront URLs are `{brand-slug}.yourapp.com`.
 * Every request needs to resolve which brand (and thus which tenant)
 * the user is interacting with.
 *
 * This module:
 * 1. Extracts brand slug from Host header
 * 2. Looks up brand in DB
 * 3. Returns full context (brand, tenant, theme)
 *
 * Cached per-request via React `cache()` (server components only).
 */

import { cache } from 'react';
import { eq, and, isNull } from 'drizzle-orm';
import { db, brands, tenants, type Brand, type Tenant } from '@rp/db';

export type BrandContext = {
  brand: Brand;
  tenant: Tenant;
};

/**
 * Extract brand slug from Host header.
 *
 * Examples:
 *   "pizza-express.yourapp.com" → "pizza-express"
 *   "pizza-express.localhost:3001" → "pizza-express"
 *   "yourapp.com" → null (root domain, no brand)
 *
 * Uses NEXT_PUBLIC_STOREFRONT_BASE_DOMAIN to determine the base.
 */
export function extractBrandSlug(host: string | null): string | null {
  if (!host) return null;

  const baseDomain = process.env.NEXT_PUBLIC_STOREFRONT_BASE_DOMAIN;
  if (!baseDomain) {
    throw new Error('NEXT_PUBLIC_STOREFRONT_BASE_DOMAIN not set');
  }

  // Strip port (for local dev like localhost:3001)
  const [hostWithoutPort = ''] = host.split(':');
  const [baseWithoutPort = ''] = baseDomain.split(':');

  if (hostWithoutPort === baseWithoutPort) {
    return null; // Root domain, no brand
  }

  if (!hostWithoutPort.endsWith(`.${baseWithoutPort}`)) {
    return null; // Not a subdomain of our base
  }

  const subdomain = hostWithoutPort.slice(0, -(baseWithoutPort.length + 1));
  // Subdomain might have multiple parts (e.g., "www.pizza-express")
  // Take the first segment as brand
  const [brandSlug = ''] = subdomain.split('.');

  // Reserved subdomains that are not brand storefronts
  const RESERVED = new Set(['www', 'admin', 'api', 'app']);
  if (!brandSlug || RESERVED.has(brandSlug)) {
    return null;
  }

  return brandSlug;
}

/**
 * Resolve brand + tenant from a slug.
 * Cached per request — multiple components can call this without DB hit.
 */
export const getBrandContext = cache(async (
  brandSlug: string
): Promise<BrandContext | null> => {
  const result = await db
    .select({
      brand: brands,
      tenant: tenants,
    })
    .from(brands)
    .innerJoin(tenants, eq(brands.tenantId, tenants.id))
    .where(
      and(
        eq(brands.slug, brandSlug),
        isNull(brands.deletedAt),
        isNull(tenants.deletedAt),
        eq(tenants.status, 'active'),
        eq(brands.isActive, true)
      )
    )
    .limit(1);

  if (!result[0]) return null;

  return result[0];
});
