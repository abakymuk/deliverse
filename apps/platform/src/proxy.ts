import { getSessionCookie } from 'better-auth/cookies';
import { type NextRequest, NextResponse } from 'next/server';

/**
 * Auth proxy for the platform app (Next 15.5+; was middleware).
 * - Public routes: /login, /signup, /forgot-password, /reset-password, /verify-email
 * - All others: require valid session
 *
 * Note: we only check for session cookie presence, not validity.
 * Full validation happens in server components via auth.api.getSession().
 * This is by design (Better-Auth recommendation) — full validation in proxy
 * adds DB round-trip to every request.
 */

const PUBLIC_PATHS = ['/login', '/signup', '/forgot-password', '/reset-password', '/verify-email'];

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Allow API routes
  if (pathname.startsWith('/api')) {
    return NextResponse.next();
  }

  // Check public paths
  if (PUBLIC_PATHS.some((p) => pathname.startsWith(p))) {
    return NextResponse.next();
  }

  // Check session cookie. Pass the cookiePrefix that platform BA is configured
  // with (packages/auth-core/src/platform.ts → advanced.cookiePrefix); otherwise
  // getSessionCookie defaults to 'better-auth' and never matches our cookie,
  // bouncing every authenticated request back to /login?next=... (DEL-17).
  const sessionCookie = getSessionCookie(request, { cookiePrefix: 'rp_platform' });
  if (!sessionCookie) {
    const loginUrl = new URL('/login', request.url);
    loginUrl.searchParams.set('next', pathname);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.).*)'],
};
