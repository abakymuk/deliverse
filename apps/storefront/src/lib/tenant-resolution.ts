/**
 * Tenant resolution: subdomain → brand → tenant (app-side helpers).
 *
 * The pure `extractBrandSlug` logic lives in `@rp/auth-core/storefront-host`
 * (so the BA adapter wrapper can use it without an apps→packages dep).
 * This module:
 *   - wraps `extractBrandSlug` to read `NEXT_PUBLIC_STOREFRONT_BASE_DOMAIN`
 *     from env (preserving the existing proxy + server-component API),
 *   - exports the React-`cache()`-memoized `getBrandContext(slug)` for
 *     server components that read the proxy-injected `x-brand-slug` header.
 */

import {
  extractBrandSlug as extractBrandSlugFromHost,
  extractStorefrontSlug as extractStorefrontSlugFromHost,
} from '@rp/auth-core/storefront-host';
import { resolveBrandBySlug } from '@rp/auth-core/storefront-tenant-resolver';
import type { BrandContext } from '@rp/auth-core/storefront-tenant-resolver';
import { cache } from 'react';

export type { BrandContext };

/**
 * Extract the brand slug from a Host header value, using
 * `NEXT_PUBLIC_STOREFRONT_BASE_DOMAIN` as the base.
 *
 * Throws if the env var is not set — that's a config error, not a request error.
 *
 * @deprecated DEL-22 — prefer {@link extractStorefrontSlug}. The BA tenant
 * resolver still consumes this; both wrappers coexist until brand-optional BA.
 */
export function extractBrandSlug(host: string | null): string | null {
  const baseDomain = process.env.NEXT_PUBLIC_STOREFRONT_BASE_DOMAIN;
  if (!baseDomain) {
    throw new Error('NEXT_PUBLIC_STOREFRONT_BASE_DOMAIN not set');
  }
  return extractBrandSlugFromHost(host, baseDomain);
}

/**
 * Extract the storefront slug from a Host header value, using
 * `NEXT_PUBLIC_STOREFRONT_BASE_DOMAIN` as the base.
 *
 * Throws if the env var is not set — that's a config error, not a request error.
 *
 * Used by the storefront proxy (DEL-20) as the routing entry point. Same value
 * as `extractBrandSlug` today; the brand-vs-tenant discriminator comes from
 * `resolveStorefrontBySlug`.
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
