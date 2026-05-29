import { db } from '@rp/db';
import { Button } from '@rp/ui/components/button';
import type { Route } from 'next';
import Link from 'next/link';

/**
 * Tenants list (DEL-35 / X4). Minimal admin table with each tenant's Stripe
 * Connect status + a link to the per-tenant detail/onboarding panel.
 *
 * Uses the relational query API (db.query) so the platform app needs no direct
 * drizzle-orm dependency. Auth is enforced by the dashboard layout.
 */
export default async function TenantsPage() {
  const rows = await db.query.tenants.findMany({
    columns: {
      id: true,
      name: true,
      slug: true,
      stripeAccountId: true,
      stripeChargesEnabled: true,
    },
    orderBy: (t, { asc }) => asc(t.name),
  });

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold">Tenants</h2>
        <p className="text-[var(--color-muted-foreground)] text-sm">
          Restaurant operators and their Stripe Connect status.
        </p>
      </div>

      <div className="overflow-hidden rounded-lg border">
        <table className="w-full text-sm">
          <thead className="border-b bg-[var(--color-muted)]/40 text-left">
            <tr>
              <th className="px-4 py-2 font-medium">Name</th>
              <th className="px-4 py-2 font-medium">Slug</th>
              <th className="px-4 py-2 font-medium">Stripe Connect</th>
              <th className="px-4 py-2" />
            </tr>
          </thead>
          <tbody>
            {rows.map((t) => (
              <tr key={t.id} className="border-b last:border-0">
                <td className="px-4 py-2">{t.name}</td>
                <td className="px-4 py-2 text-[var(--color-muted-foreground)]">{t.slug}</td>
                <td className="px-4 py-2">
                  <ConnectStatus
                    accountId={t.stripeAccountId}
                    chargesEnabled={t.stripeChargesEnabled}
                  />
                </td>
                <td className="px-4 py-2 text-right">
                  <Button asChild variant="outline" size="sm">
                    <Link href={`/dashboard/tenants/${t.id}` as Route}>Manage</Link>
                  </Button>
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td
                  colSpan={4}
                  className="px-4 py-6 text-center text-[var(--color-muted-foreground)]"
                >
                  No tenants yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ConnectStatus({
  accountId,
  chargesEnabled,
}: {
  accountId: string | null;
  chargesEnabled: boolean;
}) {
  const base = 'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium';
  if (chargesEnabled) {
    return <span className={`${base} bg-green-100 text-green-800`}>Active</span>;
  }
  if (accountId) {
    return <span className={`${base} bg-amber-100 text-amber-800`}>Onboarding</span>;
  }
  return <span className={`${base} bg-gray-100 text-gray-700`}>Not connected</span>;
}
