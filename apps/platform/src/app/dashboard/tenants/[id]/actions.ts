'use server';

import { createAccountLink, createOrReuseConnectAccount } from '@rp/payments';
import type { Route } from 'next';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth';

/**
 * Start (or resume) Stripe Connect onboarding for a tenant (DEL-35 / X4).
 *
 * Creates/reuses the tenant's Express account, mints a single-use hosted
 * Account Link, and redirects the operator to Stripe. `tenantId` is bound by
 * the caller via `action.bind(null, tenant.id)`.
 *
 * AUTHZ (v1): gated on an authenticated platform session (the dashboard layout
 * already enforces login). TODO(DEL-35 follow-up): restrict to staff or an
 * admin member of THIS tenant — today any logged-in platform user can trigger
 * onboarding for any tenant id.
 */
export async function startStripeOnboardingAction(tenantId: string): Promise<void> {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) {
    redirect('/login');
  }

  const accountId = await createOrReuseConnectAccount(tenantId);
  const url = await createAccountLink(accountId, tenantId);

  // redirect() throws NEXT_REDIRECT and must not sit inside a try/catch that
  // would swallow it. No db transaction is open here, so nothing to roll back.
  // The target is Stripe's hosted onboarding — an absolute EXTERNAL URL, so we
  // cast past the typedRoutes guard (which only knows internal app routes).
  redirect(url as Route);
}
