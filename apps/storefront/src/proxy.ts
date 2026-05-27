import { extractBrandSlug } from '@/lib/tenant-resolution';
import { getSessionCookie } from 'better-auth/cookies';
import { type NextRequest, NextResponse } from 'next/server';

/**
 * Storefront proxy (Next 16, renamed from middleware):
 * 1. Extract brand slug from Host header
 * 2. Inject brand slug as header for downstream
 * 3. Check session for protected routes
 *
 * If no valid brand slug → redirect to base domain (marketing site)
 *
 * NOTE: full brand DB lookup happens in server components (cached).
 * Proxy only handles the routing decision based on slug presence.
 */

const PUBLIC_PATHS = [
  '/',
  '/login',
  '/signup',
  '/verify-otp',
  '/forgot-password',
  '/reset-password',
];

const PROTECTED_PATHS = ['/account', '/orders'];

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const host = request.headers.get('host');

  // Always allow API routes
  if (pathname.startsWith('/api')) {
    return NextResponse.next();
  }

  const brandSlug = extractBrandSlug(host);

  // No valid brand subdomain → redirect to landing
  if (!brandSlug) {
    // In production this would redirect to marketing site
    // In dev, show a helpful error
    if (pathname === '/') {
      return new NextResponse('No brand specified. Visit {brand-slug}.localhost:3001', {
        status: 200,
      });
    }
    return NextResponse.next();
  }

  // Inject brand slug as a REQUEST header for server components downstream.
  // Per Next.js docs: NextResponse.next({ request: { headers } }) sets the
  // upstream request headers — NextResponse.next({ headers }) (no `request:`
  // wrapper) sets response headers, which the server components can't see.
  // https://nextjs.org/docs/app/api-reference/file-conventions/proxy#setting-headers
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-brand-slug', brandSlug);

  // Public paths: skip auth, pass through with brand header
  if (PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
    return NextResponse.next({ request: { headers: requestHeaders } });
  }

  // Auth check for protected paths. Pass the cookiePrefix storefront BA is
  // configured with (packages/auth-core/src/storefront.ts → advanced.cookiePrefix);
  // otherwise getSessionCookie defaults to 'better-auth' and never matches our
  // cookie, bouncing every authenticated request back to /login?next=... (DEL-17).
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
