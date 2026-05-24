import { type NextRequest, NextResponse } from 'next/server';
import { getSessionCookie } from 'better-auth/cookies';

/**
 * Auth middleware for the platform app.
 * - Public routes: /login, /signup, /forgot-password, /reset-password, /verify-email
 * - All others: require valid session
 *
 * Note: we only check for session cookie presence, not validity.
 * Full validation happens in server components via auth.api.getSession().
 * This is by design (Better-Auth recommendation) — full validation in middleware
 * adds DB round-trip to every request.
 */

const PUBLIC_PATHS = [
  '/login',
  '/signup',
  '/forgot-password',
  '/reset-password',
  '/verify-email',
];

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Allow API routes
  if (pathname.startsWith('/api')) {
    return NextResponse.next();
  }

  // Check public paths
  if (PUBLIC_PATHS.some((p) => pathname.startsWith(p))) {
    return NextResponse.next();
  }

  // Check session cookie
  const sessionCookie = getSessionCookie(request);
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
