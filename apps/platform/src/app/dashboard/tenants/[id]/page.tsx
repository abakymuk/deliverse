import { db } from '@rp/db';
import { Button } from '@rp/ui/components/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@rp/ui/components/card';
import type { Route } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { startStripeOnboardingAction } from './actions';

/**
 * Tenant detail + Stripe Connect onboarding panel (DEL-35 / X4).
 *
 * The "Connect"/"Continue" button posts to the server action, which mints a
 * hosted Account Link and redirects to Stripe. charges_enabled is flipped
 * asynchronously by the account.updated webhook, so the status shown here
 * reflects the latest DB state on each load.
 */
export default async function TenantDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const tenant = await db.query.tenants.findFirst({
    columns: {
      id: true,
      name: true,
      slug: true,
      stripeAccountId: true,
      stripeChargesEnabled: true,
    },
    where: (t, { eq }) => eq(t.id, id),
  });

  if (!tenant) notFound();

  const onboard = startStripeOnboardingAction.bind(null, tenant.id);

  return (
    <div className="max-w-2xl space-y-6">
      <Link
        href={'/dashboard/tenants' as Route}
        className="text-sm underline-offset-4 hover:underline"
      >
        ← Tenants
      </Link>

      <div>
        <h2 className="text-2xl font-bold">{tenant.name}</h2>
        <p className="text-[var(--color-muted-foreground)] text-sm">{tenant.slug}</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Stripe Connect</CardTitle>
          <CardDescription>
            {tenant.stripeChargesEnabled
              ? 'This tenant can accept payments.'
              : tenant.stripeAccountId
                ? 'Onboarding started but not yet complete — continue to finish.'
                : 'Connect a Stripe account so this tenant can accept payments.'}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <dl className="grid grid-cols-[10rem_1fr] gap-y-2 text-sm">
            <dt className="text-[var(--color-muted-foreground)]">Account</dt>
            <dd className="font-mono">{tenant.stripeAccountId ?? '—'}</dd>
            <dt className="text-[var(--color-muted-foreground)]">Charges enabled</dt>
            <dd>{tenant.stripeChargesEnabled ? 'Yes' : 'No'}</dd>
          </dl>

          <form action={onboard}>
            <Button type="submit">
              {tenant.stripeAccountId ? 'Continue Stripe onboarding' : 'Connect Stripe'}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
