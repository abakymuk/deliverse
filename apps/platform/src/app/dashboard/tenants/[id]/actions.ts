'use server';

import { db } from '@rp/db';
import { createAccountLink, createOrReuseConnectAccount, getStripe } from '@rp/payments';
import type { Route } from 'next';
import { revalidatePath } from 'next/cache';
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

/**
 * Full refund (full unwind) for a captured payment (DEL-35 / X4 step 4).
 *
 * Locked economics: `reverse_transfer` (claw the restaurant's transferred share
 * back) + `refund_application_fee` (return the platform cut). The `refunds` row,
 * `order_modifications` ledger entry, and `payment.refunded` event are written by
 * the `charge.refunded` webhook — NOT here — so this stays a thin trigger.
 * `platform_user_id` is threaded via refund metadata so the webhook stamps the
 * acting admin. tenantId + paymentId are bound by the caller (form action.bind).
 *
 * AUTHZ (v1): session-gated only — same staff/tenant-admin follow-up as onboarding.
 */
export async function refundPaymentAction(tenantId: string, paymentId: string): Promise<void> {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) {
    redirect('/login');
  }

  const payment = await db.query.payments.findFirst({
    columns: { externalId: true },
    where: (p, { and, eq }) => and(eq(p.id, paymentId), eq(p.tenantId, tenantId)),
  });
  // Unknown / wrong-tenant payment → no-op (the UI only offers valid ids).
  if (!payment) return;

  await getStripe().refunds.create({
    payment_intent: payment.externalId,
    reverse_transfer: true,
    refund_application_fee: true,
    metadata: { platform_user_id: session.user.id },
  });

  revalidatePath(`/dashboard/tenants/${tenantId}`);
}
