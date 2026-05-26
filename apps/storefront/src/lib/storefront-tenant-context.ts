/**
 * Next-aware tenant-context resolver for the storefront BA factory.
 *
 * Passed into `createStorefrontAuth(...)` in `lib/auth.ts`. The wrapper
 * (packages/auth-core/src/storefront-adapter.ts) invokes this on every
 * scoped adapter method call.
 *
 * On any failure path (no host, no brand subdomain, slug doesn't resolve
 * to an active brand) throws `APIError('BAD_REQUEST', ...)` so BA returns
 * a structured 400 to the HTTP layer (matches the precedent in
 * `node_modules/better-auth/dist/db/schema.mjs:47-50`).
 *
 * Spec: docs/specs/storefront-tenant-scoping.md §5.3.
 */

import type { StorefrontTenantContext } from '@rp/auth-core/storefront-adapter';
import { extractBrandSlug } from '@rp/auth-core/storefront-host';
import { resolveBrandBySlug } from '@rp/auth-core/storefront-tenant-resolver';
import { APIError } from 'better-auth';
import { headers } from 'next/headers';

function badRequest(message: string): never {
  throw new APIError('BAD_REQUEST', {
    message,
    code: 'TENANT_CONTEXT_REQUIRED',
  });
}

function sanitizeHost(host: string | null | undefined): string {
  if (!host) return '<missing>';
  return host.toLowerCase().slice(0, 100);
}

export async function resolveStorefrontTenantContext(): Promise<StorefrontTenantContext> {
  const h = await headers();
  const host = h.get('host');
  const baseDomain = process.env.NEXT_PUBLIC_STOREFRONT_BASE_DOMAIN;

  const slug = extractBrandSlug(host, baseDomain);
  if (!slug) {
    badRequest(
      `no resolvable tenant for storefront request — host=${sanitizeHost(host)} (no brand subdomain)`,
    );
  }

  const brandContext = await resolveBrandBySlug(slug);
  if (!brandContext) {
    badRequest(
      `no resolvable tenant for storefront request — host=${sanitizeHost(host)} (brand "${slug}" not found or inactive)`,
    );
  }

  return {
    tenantId: brandContext.tenant.id,
    brandId: brandContext.brand.id,
  };
}
