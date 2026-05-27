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
import { extractStorefrontSlug } from '@rp/auth-core/storefront-host';
import { resolveStorefrontBySlug } from '@rp/auth-core/storefront-resolver';
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

  // DEL-22: resolve to a storefront (brand-type or tenant-type) per ADR-0012.
  // Brand-host requests get `brandId`/`brandSlug` populated; tenant-host
  // requests get them undefined. 400 only when tenant is unresolvable.
  // Error messages preserve the "no resolvable tenant" prefix consumed by the
  // DEL-3 AC#5 e2e regex.
  const slug = extractStorefrontSlug(host, baseDomain);
  if (!slug) {
    badRequest(
      `no resolvable tenant for storefront request — host=${sanitizeHost(host)} (no storefront subdomain)`,
    );
  }

  const sf = await resolveStorefrontBySlug(slug);
  if (!sf) {
    badRequest(
      `no resolvable tenant for storefront request — host=${sanitizeHost(host)} (storefront "${slug}" not found or inactive)`,
    );
  }

  return {
    tenantId: sf.tenantId,
    storefrontId: sf.storefrontId,
    storefrontType: sf.storefrontType,
    storefrontSlug: slug,
    brandId: sf.brandId,
    brandSlug: sf.storefrontType === 'brand' ? slug : undefined,
  };
}
