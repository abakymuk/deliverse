/**
 * Stripe Connect onboarding — Express accounts + destination charges.
 *
 * createOrReuseConnectAccount persists the acct_… id at creation time so a
 * re-click reuses the same Express account (no duplicates). charges_enabled is
 * NOT decided here — the account.updated webhook flips
 * tenants.stripe_charges_enabled once Stripe verifies the account (handlers.ts).
 *
 * These run from the platform admin server action (not the webhook tx), so the
 * outbound Stripe calls are never inside a db.transaction.
 */

import { db } from '@rp/db';
import { tenants } from '@rp/db/schema';
import { eq } from 'drizzle-orm';
import { getStripe } from './client';

/**
 * Return the tenant's Connect account id, creating an Express account on first
 * call. Application-level idempotent: if tenants.stripe_account_id is already
 * set, returns it without hitting Stripe.
 */
export async function createOrReuseConnectAccount(tenantId: string): Promise<string> {
  const [tenant] = await db
    .select({ stripeAccountId: tenants.stripeAccountId })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);

  if (!tenant) {
    throw new Error(`createOrReuseConnectAccount: tenant ${tenantId} not found`);
  }
  if (tenant.stripeAccountId) {
    return tenant.stripeAccountId;
  }

  const account = await getStripe().accounts.create({
    type: 'express',
    metadata: { tenant_id: tenantId },
    // Destination charges: the connected account needs `transfers`; request
    // card_payments too so Express onboarding collects everything in one pass.
    capabilities: {
      card_payments: { requested: true },
      transfers: { requested: true },
    },
  });

  // Persist immediately so a retry / re-click reuses this account rather than
  // creating an orphan. (If this update fails after Stripe created the account,
  // the next call creates a second account — acceptable at v1; revisit if it
  // bites.)
  await db
    .update(tenants)
    .set({ stripeAccountId: account.id, updatedAt: new Date() })
    .where(eq(tenants.id, tenantId));

  return account.id;
}

/**
 * Create a single-use hosted-onboarding Account Link. return_url / refresh_url
 * point back to the tenant detail page; Stripe calls refresh_url if the link
 * expires before completion (the page's Connect button re-initiates).
 */
export async function createAccountLink(accountId: string, tenantId: string): Promise<string> {
  const base = process.env.NEXT_PUBLIC_PLATFORM_URL ?? 'http://localhost:3000';
  const link = await getStripe().accountLinks.create({
    account: accountId,
    type: 'account_onboarding',
    refresh_url: `${base}/dashboard/tenants/${tenantId}?stripe=refresh`,
    return_url: `${base}/dashboard/tenants/${tenantId}?stripe=return`,
  });
  return link.url;
}
