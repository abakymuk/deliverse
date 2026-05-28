/**
 * Tenant resolution: subdomain → storefront → brand/tenant (app-side helpers).
 *
 * The pure `extractStorefrontSlug` logic lives in `@rp/auth-core/storefront-host`
 * (so the BA adapter wrapper can use it without an apps→packages dep).
 * This module:
 *   - wraps `extractStorefrontSlug` to read `NEXT_PUBLIC_STOREFRONT_BASE_DOMAIN`
 *     from env (preserving the existing proxy + server-component API),
 *   - exports the React-`cache()`-memoized `getBrandContext(slug)` for
 *     server components that read the proxy-injected `x-brand-slug` header,
 *   - exports the React-`cache()`-memoized `getStorefrontContext()` that
 *     wraps `resolveStorefrontTenantContext()` with a `null`-on-failure
 *     contract for RSC pages.
 */

import { extractStorefrontSlug as extractStorefrontSlugFromHost } from '@rp/auth-core/storefront-host';
import type { StorefrontTenantContext } from '@rp/auth-core/storefront-adapter';
import { resolveBrandBySlug } from '@rp/auth-core/storefront-tenant-resolver';
import type { BrandContext } from '@rp/auth-core/storefront-tenant-resolver';
import { cache } from 'react';
import { resolveStorefrontTenantContext } from './storefront-tenant-context';

export type { BrandContext, StorefrontTenantContext };

/**
 * Extract the storefront slug from a Host header value, using
 * `NEXT_PUBLIC_STOREFRONT_BASE_DOMAIN` as the base.
 *
 * Throws if the env var is not set — that's a config error, not a request error.
 *
 * Used by the storefront proxy (DEL-20) as the routing entry point.
 */
export function extractStorefrontSlug(host: string | null): string | null {
  const baseDomain = process.env.NEXT_PUBLIC_STOREFRONT_BASE_DOMAIN;
  if (!baseDomain) {
    throw new Error('NEXT_PUBLIC_STOREFRONT_BASE_DOMAIN not set');
  }
  return extractStorefrontSlugFromHost(host, baseDomain);
}

/**
 * Resolve brand + tenant from a slug.
 * Cached per request — multiple components can call this without DB hit.
 */
export const getBrandContext = cache(async (brandSlug: string): Promise<BrandContext | null> => {
  return resolveBrandBySlug(brandSlug);
});

/**
 * Page-friendly wrapper around `resolveStorefrontTenantContext()`.
 *
 * `resolveStorefrontTenantContext()` throws `APIError('BAD_REQUEST', ...)` on
 * malformed requests (no host, unknown slug, etc.) — the right behavior for
 * BA's HTTP-layer error mapping. For RSC pages we want `null` instead so the
 * page layer can call `notFound()` for a 404 response.
 *
 * Cached per request — multiple components calling `getStorefrontContext`
 * share a single resolve.
 *
 * DEL-25 / docs/specs/food-hall-storefront.md.
 */
export const getStorefrontContext = cache(
  async (): Promise<StorefrontTenantContext | null> => {
    try {
      return await resolveStorefrontTenantContext();
    } catch {
      return null;
    }
  },
);
