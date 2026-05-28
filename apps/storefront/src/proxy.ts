import { extractStorefrontSlug } from '@/lib/tenant-resolution';
import { extractHostFromUrl } from '@rp/auth-core/storefront-host';
import { resolveStorefrontBySlug } from '@rp/auth-core/storefront-resolver';
import { getSessionCookie } from 'better-auth/cookies';
import { type NextRequest, NextResponse } from 'next/server';

/**
 * Storefront proxy (Next 16, renamed from middleware) — DEL-20.
 *
 * Order of operations (each step runs before any branching):
 *   1. Clone request headers and STRIP `x-storefront-*` / `x-brand-slug` —
 *      the proxy is the sole writer of these. Stripping on every path
 *      (reserved subdomain, `/api`, no-host, unknown slug, resolved) is
 *      defense-in-depth against client-supplied spoofing.
 *   2. Short-circuit `/api`. BA resolves tenant via `host` (or, when this
 *      proxy injects them, Referer/Origin) inside the BA route handler —
 *      see `apps/storefront/src/lib/storefront-tenant-context.ts`. The
 *      proxy intentionally does NOT inject on `/api/*` so we don't pay a
 *      slug-resolution penalty on every BA call. Spec:
 *      `docs/specs/cookie-cache-tenant-version.md` AC#4.
 *   3. Extract storefront slug from `Host`. Reserved subdomains short-circuit.
 *   4. **Bare-host fallback** (cookie-cache-tenant-version AC#4): when
 *      `Host` yields no slug, try `Referer` → `Origin` URL hosts. Covers
 *      the Next.js 16 post-server-action-redirect render path where the
 *      framework drops the storefront subdomain from `Host`.
 *   5. Resolve slug → storefront context via DB. Unknown slug short-circuits.
 *   6. Inject authoritative `x-storefront-id`, `x-storefront-type`,
 *      `x-storefront-name`. Inject `x-brand-slug` only when `type='brand'`.
 *   7. Public/protected path branching unchanged (DEL-17 cookie prefix preserved).
 */

const PUBLIC_PATHS = [
  '/',
  '/login',
  '/signup',
  '/verify-otp',
  '/forgot-password',
  '/reset-password',
];

// DEL-25 PR 25b: /cart added — passive cart views require login; the
// cart-server-actions also re-check session and redirect, but the proxy
// gate is cheaper for unauthenticated GETs.
const PROTECTED_PATHS = ['/account', '/orders', '/cart', '/checkout'];

const PROXY_OWNED_HEADERS = [
  'x-storefront-id',
  'x-storefront-type',
  'x-storefront-name',
  'x-brand-slug',
] as const;

/**
 * Resolve the storefront slug from the request's hostable headers, in the
 * same precedence order as the BA resolver (Host → Referer → Origin). The
 * `x-storefront-id` source (which the resolver tries first) is the proxy's
 * output, not its input — the proxy IS what populates it.
 */
function resolveSlugFromRequest(request: NextRequest): string | null {
  const hostSlug = extractStorefrontSlug(request.headers.get('host'));
  if (hostSlug) return hostSlug;

  const refererSlug = extractStorefrontSlug(
    extractHostFromUrl(request.headers.get('referer')),
  );
  if (refererSlug) return refererSlug;

  const originSlug = extractStorefrontSlug(
    extractHostFromUrl(request.headers.get('origin')),
  );
  if (originSlug) return originSlug;

  return null;
}

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  const requestHeaders = new Headers(request.headers);
  for (const h of PROXY_OWNED_HEADERS) requestHeaders.delete(h);

  if (pathname.startsWith('/api')) {
    return NextResponse.next({ request: { headers: requestHeaders } });
  }

  const slug = resolveSlugFromRequest(request);

  if (!slug) {
    if (pathname === '/') {
      return new NextResponse('No brand specified. Visit {brand-slug}.localhost:3001', {
        status: 200,
      });
    }
    return NextResponse.next({ request: { headers: requestHeaders } });
  }

  const ctx = await resolveStorefrontBySlug(slug);

  if (!ctx) {
    return NextResponse.next({ request: { headers: requestHeaders } });
  }

  requestHeaders.set('x-storefront-id', ctx.storefrontId);
  requestHeaders.set('x-storefront-type', ctx.storefrontType);
  requestHeaders.set('x-storefront-name', ctx.storefrontName);
  if (ctx.storefrontType === 'brand') {
    requestHeaders.set('x-brand-slug', slug);
  }

  if (PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
    return NextResponse.next({ request: { headers: requestHeaders } });
  }

  if (PROTECTED_PATHS.some((p) => pathname.startsWith(p))) {
    const sessionCookie = getSessionCookie(request, { cookiePrefix: 'rp_store' });
    if (!sessionCookie) {
      const loginUrl = new URL('/login', request.url);
      loginUrl.searchParams.set('next', pathname);
      return NextResponse.redirect(loginUrl);
    }
  }

  return NextResponse.next({ request: { headers: requestHeaders } });
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.).*)'],
};
