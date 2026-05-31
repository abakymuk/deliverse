import { db } from '@rp/db';
import { headers } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { auth, type Session } from '@/lib/auth';

type TenantAction = 'startStripeOnboarding' | 'refundPayment';

/**
 * Authorize the caller to act on `tenantId` (DEL-46).
 *
 * Allowed iff the caller is platform staff OR a member of the target tenant with
 * role `owner`/`manager`. Unauthenticated callers are redirected to `/login`;
 * authenticated-but-unauthorized callers get `notFound()` — 404, never 403 (per
 * docs/auth-spec.md): a 403 would confirm the tenant exists (enumeration oracle).
 *
 * Staff status and soft-delete are read FRESH from the DB rather than the
 * cookie-cached session (5-min TTL), so staff revocation / account deletion take
 * effect immediately on these money/Connect actions. Returns the session so
 * callers can read `session.user.id`.
 */
export async function requireTenantAccess(
  tenantId: string,
  action: TenantAction,
): Promise<NonNullable<Session>> {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) {
    redirect('/login');
  }

  const deny = (reason: string): never => {
    console.warn({
      component: 'requireTenantAccess',
      action,
      userId: session.user.id,
      tenantId,
      reason,
    });
    notFound();
  };

  // Single fresh read: reject soft-deleted / vanished users (Better-Auth doesn't
  // know our `deletedAt` semantics, so a soft-deleted user can still hold a live
  // session cookie) AND fetch the staff flag. Guards both allow paths below.
  const user = await db.query.platformUsers.findFirst({
    columns: { isPlatformStaff: true, deletedAt: true },
    where: (u, { eq }) => eq(u.id, session.user.id),
  });
  if (!user || user.deletedAt) {
    return deny('user_inactive');
  }
  if (user.isPlatformStaff === true) {
    return session;
  }

  // Tenant owner/manager. NOTE the per-tenant `staff`/`viewer` roles do NOT
  // qualify — they are unrelated to (global) platform staff.
  const membership = await db.query.tenantMemberships.findFirst({
    columns: { role: true },
    where: (m, { and, eq }) =>
      and(eq(m.platformUserId, session.user.id), eq(m.tenantId, tenantId)),
  });
  if (membership?.role === 'owner' || membership?.role === 'manager') {
    return session;
  }

  return deny(membership ? `insufficient_role:${membership.role}` : 'not_a_member');
}
