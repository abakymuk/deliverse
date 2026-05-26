/**
 * Tenant resolution: subdomain → brand → tenant
 *
 * Storefront URLs are `{brand-slug}.deliverse.app`.
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

import { type Brand, type Tenant, brands, db, tenants } from '@rp/db';
import { and, eq, isNull } from 'drizzle-orm';
import { cache } from 'react';

export type BrandContext = {
  brand: Brand;
  tenant: Tenant;
};

/**
 * Extract brand slug from Host header.
 *
 * Examples:
 *   "pizza-express.deliverse.app" → "pizza-express"
 *   "pizza-express.localhost:3001" → "pizza-express"
 *   "deliverse.app" → null (root domain, no brand)
 *
 * Uses NEXT_PUBLIC_STOREFRONT_BASE_DOMAIN to determine the base.
 */
/**
 * Lowercase + strip optional `<scheme>://` prefix + strip optional `:port`
 * suffix. Tolerates both `localhost:3001` and `http://localhost:3001`
 * shapes for the env var (docs prescribe the former; the dev Doppler
 * config historically used the latter — defensive parsing keeps both
 * working without a Doppler edit).
 */
function normalizeDomain(s: string): string {
  let v = s.toLowerCase();
  const schemeIdx = v.indexOf('://');
  if (schemeIdx >= 0) v = v.slice(schemeIdx + 3);
  const portIdx = v.indexOf(':');
  if (portIdx >= 0) v = v.slice(0, portIdx);
  const slashIdx = v.indexOf('/');
  if (slashIdx >= 0) v = v.slice(0, slashIdx);
  return v;
}

export function extractBrandSlug(host: string | null): string | null {
  if (!host) return null;

  const baseDomain = process.env.NEXT_PUBLIC_STOREFRONT_BASE_DOMAIN;
  if (!baseDomain) {
    throw new Error('NEXT_PUBLIC_STOREFRONT_BASE_DOMAIN not set');
  }

  const hostWithoutPort = normalizeDomain(host);
  const baseWithoutPort = normalizeDomain(baseDomain);

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
export const getBrandContext = cache(async (brandSlug: string): Promise<BrandContext | null> => {
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
        eq(brands.isActive, true),
      ),
    )
    .limit(1);

  if (!result[0]) return null;

  return result[0];
});
