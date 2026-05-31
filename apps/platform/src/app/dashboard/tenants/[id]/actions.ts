'use server';

import { db } from '@rp/db';
import { createAccountLink, createOrReuseConnectAccount, getStripe } from '@rp/payments';
import type { Route } from 'next';
import { revalidatePath } from 'next/cache';
import { notFound, redirect } from 'next/navigation';
import { requireTenantAccess } from '@/lib/authz';

/**
 * Start (or resume) Stripe Connect onboarding for a tenant (DEL-35 / X4).
 *
 * Creates/reuses the tenant's Express account, mints a single-use hosted
 * Account Link, and redirects the operator to Stripe. `tenantId` is bound by
 * the caller via `action.bind(null, tenant.id)`.
 *
 * AUTHZ (DEL-46): requireTenantAccess() restricts this to platform staff or an
 * owner/manager of THIS tenant — everyone else gets 404 before any Stripe call.
 */
export async function startStripeOnboardingAction(tenantId: string): Promise<void> {
  await requireTenantAccess(tenantId, 'startStripeOnboarding');

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
 * AUTHZ (DEL-46): requireTenantAccess() restricts this to platform staff or an
 * owner/manager of THIS tenant. The payment lookup is additionally tenant-scoped,
 * so a valid id from another tenant 404s rather than refunding.
 */
export async function refundPaymentAction(tenantId: string, paymentId: string): Promise<void> {
  const session = await requireTenantAccess(tenantId, 'refundPayment');

  const payment = await db.query.payments.findFirst({
    columns: { externalId: true },
    where: (p, { and, eq }) => and(eq(p.id, paymentId), eq(p.tenantId, tenantId)),
  });
  // Unknown / wrong-tenant payment → 404 (no cross-tenant refund by id-guessing).
  if (!payment) {
    notFound();
  }

  await getStripe().refunds.create({
    payment_intent: payment.externalId,
    reverse_transfer: true,
    refund_application_fee: true,
    metadata: { platform_user_id: session.user.id },
  });

  revalidatePath(`/dashboard/tenants/${tenantId}`);
}
