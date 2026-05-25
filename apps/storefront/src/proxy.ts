import { type NextRequest, NextResponse } from 'next/server';
import { getSessionCookie } from 'better-auth/cookies';
import { extractBrandSlug } from '@/lib/tenant-resolution';

/**
 * Storefront proxy (Next 15.5+; was middleware):
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
      return new NextResponse(
        'No brand specified. Visit {brand-slug}.localhost:3001',
        { status: 200 }
      );
    }
    return NextResponse.next();
  }

  // Inject brand slug as header for server components
  const headers = new Headers(request.headers);
  headers.set('x-brand-slug', brandSlug);

  // Public paths: skip auth, pass through with brand header
  if (
    PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`))
  ) {
    return NextResponse.next({ headers });
  }

  // Auth check for protected paths
  if (PROTECTED_PATHS.some((p) => pathname.startsWith(p))) {
    const sessionCookie = getSessionCookie(request);
    if (!sessionCookie) {
      const loginUrl = new URL('/login', request.url);
      loginUrl.searchParams.set('next', pathname);
      return NextResponse.redirect(loginUrl);
    }
  }

  return NextResponse.next({ headers });
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.).*)'],
};
