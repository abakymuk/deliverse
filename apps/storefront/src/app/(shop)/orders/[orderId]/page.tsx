import { db } from '@rp/db';
import { orderIntents, payments, tenants } from '@rp/db/schema';
import { desc, eq } from 'drizzle-orm';
import { headers } from 'next/headers';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { auth } from '@/lib/auth';
import { OrderSummary } from '@/components/orders/order-summary';
import { PayPanel } from './pay-panel';

type Params = { orderId: string };

/**
 * Order detail page — `/orders/<orderId>`.
 *
 * RSC. Resolves session, loads the order by id, then verifies:
 *
 *   - `order.tenantEndUserId === session.user.id` (cross-user guard)
 *
 * If the check fails, `notFound()` — never surface another user's order
 * even when the URL is correct. Loading by ID alone (no ownership
 * check) would let an attacker enumerate other users' orders simply by
 * guessing UUIDs.
 *
 * **Why no cross-tenant guard here**: `tenant_end_users` are
 * tenant-scoped per [ADR-0003](../../../decisions/0003-tenant-scoped-end-users.md),
 * and Better-Auth sessions are bound to a single tenant via the
 * wrapped Drizzle adapter (DEL-3). A session at tenant A can never
 * authenticate against a user row at tenant B because `tenantEndUsers`
 * are isolated per tenant. So `order.tenantEndUserId === session.user.id`
 * implicitly enforces tenant scoping — the session.user.id only matches
 * orders that belong to the session's tenant. No separate storefront-
 * context check is needed (and avoiding it makes the page robust to
 * Next.js's server-action redirect handling, which can drop the
 * subdomain from the Host header for the post-redirect page render).
 *
 * Note: `order_intents.tenant_end_user_id` is NULLABLE (ON DELETE SET NULL,
 * carried over from the old orders table per DEL-32 / X1 — GDPR
 * right-to-be-forgotten preserves the intent without the user link). A NULL
 * value never matches a session userId, so anonymized intents are
 * inaccessible by definition.
 *
 * DEL-25 PR 25c / docs/specs/food-hall-storefront.md.
 */
export default async function OrderDetailPage({
  params,
}: {
  params: Promise<Params>;
}) {
  const { orderId } = await params;
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user) {
    // Proxy gates /orders via PROTECTED_PATHS, but defense-in-depth.
    notFound();
  }

  const [orderIntent] = await db
    .select()
    .from(orderIntents)
    .where(eq(orderIntents.id, orderId))
    .limit(1);
  if (!orderIntent) notFound();
  if (orderIntent.tenantEndUserId !== session.user.id) notFound();

  // Latest payment for this order (if any) + whether the tenant can take charges.
  const [latestPayment] = await db
    .select({ status: payments.status })
    .from(payments)
    .where(eq(payments.orderIntentId, orderIntent.id))
    .orderBy(desc(payments.createdAt))
    .limit(1);
  const [tenant] = await db
    .select({ chargesEnabled: tenants.stripeChargesEnabled })
    .from(tenants)
    .where(eq(tenants.id, orderIntent.tenantId))
    .limit(1);

  const isPaid =
    latestPayment?.status === 'captured' || latestPayment?.status === 'partially_refunded';
  const isRefunded = latestPayment?.status === 'refunded';

  return (
    <div className="container mx-auto p-8">
      <div className="mb-6">
        <Link
          href="/"
          className="text-sm text-[var(--color-muted-foreground)] hover:underline"
        >
          ← Back to the menu
        </Link>
      </div>
      <h1 className="text-4xl font-bold">Order placed</h1>
      <p className="mt-2 text-[var(--color-muted-foreground)]">
        Order #{orderIntent.id.slice(0, 8)}
      </p>
      <div className="mt-8">
        <OrderSummary orderIntent={orderIntent} />
      </div>

      <div className="mt-8">
        <h2 className="text-lg font-semibold">Payment</h2>
        {isPaid ? (
          <p className="mt-2 text-sm text-green-700">Paid — thank you!</p>
        ) : isRefunded ? (
          <p className="mt-2 text-sm text-[var(--color-muted-foreground)]">Refunded.</p>
        ) : orderIntent.status !== 'placed' ? (
          <p className="mt-2 text-sm text-[var(--color-muted-foreground)]">
            This order is {orderIntent.status}.
          </p>
        ) : tenant?.chargesEnabled ? (
          <div className="mt-3">
            <PayPanel orderId={orderIntent.id} />
          </div>
        ) : (
          <p className="mt-2 text-sm text-[var(--color-muted-foreground)]">
            Online payment is not available for this restaurant yet.
          </p>
        )}
      </div>
    </div>
  );
}
