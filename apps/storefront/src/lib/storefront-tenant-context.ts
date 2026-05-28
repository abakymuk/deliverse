/**
 * Next-aware tenant-context resolver for the storefront BA factory.
 *
 * Passed into `createStorefrontAuth(...)` in `lib/auth.ts`. The wrapper
 * (packages/auth-core/src/storefront-adapter.ts) invokes this on every
 * scoped adapter method call. The BA `session.cookieCache.version`
 * callback invokes this on every `get-session` request (read time) and
 * post-signin/signup (write time) per
 * `docs/specs/cookie-cache-tenant-version.md` AC#2.
 *
 * **Resolver precedence chain** (cookie-cache-tenant-version AC#3):
 *
 *   1. `x-storefront-id` header — proxy-injected UUID. Trusted only
 *      because `apps/storefront/src/proxy.ts` strips client-supplied
 *      `PROXY_OWNED_HEADERS` (line 48-49) BEFORE its own injection. If
 *      that strip-before-inject ordering ever flips, source #1 becomes
 *      spoofable; this is the entire security property.
 *   2. `Host` header + `extractStorefrontSlug` — the canonical source for
 *      `/api/*` requests (the proxy short-circuits `/api/*` without
 *      injecting) and any direct adapter call.
 *   3. `Referer` header (URL → host → slug) — fallback for the post-
 *      server-action-redirect render path where Next.js 16 drops the
 *      storefront subdomain from `Host`.
 *   4. `Origin` header (URL → host → slug) — last-resort backup if Referer
 *      is stripped (privacy headers, CORS).
 *
 * On any failure path (all four sources fail) throws
 * `APIError('BAD_REQUEST', { code: 'TENANT_CONTEXT_REQUIRED' })` so BA
 * returns a structured 400 to the HTTP layer (matches the precedent in
 * `node_modules/better-auth/dist/db/schema.mjs:47-50`).
 *
 * The export is wrapped in React `cache()` (AC#5 implementation goal) so
 * per-render duplicate invocations dedupe. This is a soft optimisation,
 * not a correctness gate — see the spec § AC#5 for why we don't enforce
 * it via unit tests.
 *
 * Specs:
 *   - docs/specs/cookie-cache-tenant-version.md (this PR — AC#3 + AC#5)
 *   - docs/specs/storefront-tenant-scoping.md §5.3 (DEL-3 origin)
 *   - docs/specs/ba-brand-optional.md (DEL-22 brand-optional resolver)
 */

import type { StorefrontTenantContext } from '@rp/auth-core/storefront-adapter';
import {
  extractHostFromUrl,
  extractStorefrontSlug,
} from '@rp/auth-core/storefront-host';
import {
  resolveStorefrontById,
  resolveStorefrontBySlug,
} from '@rp/auth-core/storefront-resolver';
import { APIError } from 'better-auth';
import { headers } from 'next/headers';
import { cache } from 'react';

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

async function resolveBySlug(
  slug: string,
): Promise<StorefrontTenantContext | null> {
  const sf = await resolveStorefrontBySlug(slug);
  if (!sf) return null;
  return {
    tenantId: sf.tenantId,
    storefrontId: sf.storefrontId,
    storefrontType: sf.storefrontType,
    storefrontSlug: slug,
    brandId: sf.brandId,
    brandSlug: sf.storefrontType === 'brand' ? slug : undefined,
  };
}

export const resolveStorefrontTenantContext = cache(
  async (): Promise<StorefrontTenantContext> => {
    const h = await headers();
    const baseDomain = process.env.NEXT_PUBLIC_STOREFRONT_BASE_DOMAIN;

    // Source #1 — `x-storefront-id` (proxy-injected UUID). See header-doc
    // for the strip-before-inject security property. Validate UUID shape
    // upstream in `resolveStorefrontById` to skip a DB call on garbage.
    const storefrontIdHeader = h.get('x-storefront-id');
    if (storefrontIdHeader) {
      const sf = await resolveStorefrontById(storefrontIdHeader);
      if (sf) {
        return {
          tenantId: sf.tenantId,
          storefrontId: sf.storefrontId,
          storefrontType: sf.storefrontType,
          storefrontSlug: sf.slug,
          brandId: sf.brandId,
          brandSlug: sf.storefrontType === 'brand' ? sf.slug : undefined,
        };
      }
      // Fall through if the id doesn't resolve to an active storefront —
      // defense-in-depth against a stale proxy injection or a deleted row.
    }

    // Source #2 — `Host` header. Canonical for /api/* requests and any
    // direct adapter call. Preserves the DEL-3 AC#5 error-message prefix
    // ("no resolvable tenant for storefront request") consumed by the
    // negative regex in storefront-tenant-scoping.spec.ts.
    const host = h.get('host');
    const hostSlug = extractStorefrontSlug(host, baseDomain);
    if (hostSlug) {
      const ctx = await resolveBySlug(hostSlug);
      if (ctx) return ctx;
    }

    // Source #3 — `Referer` header. The fallback for Next.js 16's post-
    // server-action-redirect render: the bare `Host` strips the subdomain,
    // but the browser-sent Referer still points to the originating page
    // on the storefront subdomain. The order-detail page is the canonical
    // case (`apps/storefront/src/app/(shop)/orders/[orderId]/page.tsx`
    // documents the quirk inline).
    const refererHost = extractHostFromUrl(h.get('referer'));
    const refererSlug = extractStorefrontSlug(refererHost, baseDomain);
    if (refererSlug) {
      const ctx = await resolveBySlug(refererSlug);
      if (ctx) return ctx;
    }

    // Source #4 — `Origin` header. Last-resort if Referer is stripped
    // (Permissions-Policy `referrer`, strict referrer policy, etc.).
    // Origin is sent on CORS-relevant requests and on same-origin POSTs
    // in modern browsers.
    const originHost = extractHostFromUrl(h.get('origin'));
    const originSlug = extractStorefrontSlug(originHost, baseDomain);
    if (originSlug) {
      const ctx = await resolveBySlug(originSlug);
      if (ctx) return ctx;
    }

    // All four sources exhausted — preserve the original DEL-22 message
    // shape so existing tests + log greps still match. Host is the most
    // informative single field to expose; Referer/Origin would be PII-ish.
    badRequest(
      hostSlug || refererSlug || originSlug
        ? `no resolvable tenant for storefront request — host=${sanitizeHost(host)} (storefront "${hostSlug ?? refererSlug ?? originSlug}" not found or inactive)`
        : `no resolvable tenant for storefront request — host=${sanitizeHost(host)} (no storefront subdomain on host, referer, or origin)`,
    );
  },
);
