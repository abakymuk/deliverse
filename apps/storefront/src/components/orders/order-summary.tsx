import { db } from '@rp/db';
import type { OrderIntent } from '@rp/db';
import { orderFulfillments, orderIntentItems } from '@rp/db/schema';
import { asc, eq } from 'drizzle-orm';

type OrderSummaryProps = {
  orderIntent: OrderIntent;
};

/**
 * RSC. Renders the line items + totals for an order intent, grouped by brand,
 * with each brand's fulfillment status (DEL-32 / X1).
 *
 * Self-fetching: queries order_intent_items + order_fulfillments by intent id
 * (kept self-fetching rather than prop-driven). Uses snapshot columns
 * (`brand_name_snapshot`, `name_snapshot`, snapshot prices) rather than
 * joining live brand/menu_item rows:
 *
 * - `order_intent_items.brand_id` is `ON DELETE SET NULL` — if the brand is
 *   removed, the FK clears but `brand_name_snapshot` preserves identity.
 * - `menu_item_id_snapshot` is a soft pointer (no FK) — survives menu item
 *   hard-delete.
 *
 * The snapshot-first read keeps order detail rendering stable across
 * post-checkout brand/menu mutations.
 */
export async function OrderSummary({ orderIntent }: OrderSummaryProps) {
  const lines = await db
    .select({
      id: orderIntentItems.id,
      brandNameSnapshot: orderIntentItems.brandNameSnapshot,
      nameSnapshot: orderIntentItems.nameSnapshot,
      quantity: orderIntentItems.quantity,
      unitPriceCents: orderIntentItems.unitPriceCents,
      totalCents: orderIntentItems.totalCents,
    })
    .from(orderIntentItems)
    .where(eq(orderIntentItems.orderIntentId, orderIntent.id))
    .orderBy(asc(orderIntentItems.brandNameSnapshot));

  // Per-brand fulfillment tickets (DEL-32 / X1) — one per brand in v1.
  const fulfillments = await db
    .select({
      brandNameSnapshot: orderFulfillments.brandNameSnapshot,
      status: orderFulfillments.status,
      fulfillmentType: orderFulfillments.fulfillmentType,
    })
    .from(orderFulfillments)
    .where(eq(orderFulfillments.orderIntentId, orderIntent.id))
    .orderBy(asc(orderFulfillments.brandNameSnapshot));

  const fulfillmentByBrand = new Map(
    fulfillments.map((f) => [f.brandNameSnapshot, f]),
  );

  // Group lines by brand name (snapshot — preserves grouping even after a
  // brand soft/hard delete).
  const byBrand = new Map<string, typeof lines>();
  for (const line of lines) {
    const existing = byBrand.get(line.brandNameSnapshot);
    if (existing) {
      existing.push(line);
    } else {
      byBrand.set(line.brandNameSnapshot, [line]);
    }
  }

  const subtotal = (orderIntent.subtotalCents / 100).toFixed(2);
  const tax = (orderIntent.taxCents / 100).toFixed(2);
  const fee = (orderIntent.feeCents / 100).toFixed(2);
  const tip = (orderIntent.tipCents / 100).toFixed(2);
  const total = (orderIntent.totalCents / 100).toFixed(2);

  // v1: fulfillment type is uniform across brands (copied from the cart).
  const fulfillmentType = fulfillments[0]?.fulfillmentType ?? null;

  return (
    <div className="space-y-8">
      <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-1 text-sm">
        <dt className="text-[var(--color-muted-foreground)]">Status</dt>
        <dd className="font-medium capitalize">{orderIntent.status}</dd>
        {fulfillmentType && (
          <>
            <dt className="text-[var(--color-muted-foreground)]">Fulfillment</dt>
            <dd className="font-medium capitalize">
              {fulfillmentType.replace('_', ' ')}
            </dd>
          </>
        )}
        <dt className="text-[var(--color-muted-foreground)]">Placed</dt>
        <dd className="font-medium">
          {orderIntent.createdAt instanceof Date
            ? orderIntent.createdAt.toLocaleString()
            : new Date(orderIntent.createdAt).toLocaleString()}
        </dd>
      </dl>

      {Array.from(byBrand.entries()).map(([brandName, brandLines]) => {
        const fulfillment = fulfillmentByBrand.get(brandName);
        return (
          <section key={brandName}>
            <div className="flex items-baseline justify-between gap-4">
              <h2 className="text-xl font-semibold">{brandName}</h2>
              {fulfillment && (
                <span className="text-sm capitalize text-[var(--color-muted-foreground)]">
                  {fulfillment.status}
                </span>
              )}
            </div>
            <ul className="mt-2 divide-y divide-[var(--color-border)]">
              {brandLines.map((l) => (
                <li
                  key={l.id}
                  className="flex items-start justify-between gap-4 py-3"
                >
                  <div className="min-w-0 flex-1">
                    <p className="font-medium">{l.nameSnapshot}</p>
                    <p className="text-sm text-[var(--color-muted-foreground)]">
                      Qty {l.quantity} · ${(l.unitPriceCents / 100).toFixed(2)} ea
                    </p>
                  </div>
                  <p className="font-semibold tabular-nums">
                    ${(l.totalCents / 100).toFixed(2)}
                  </p>
                </li>
              ))}
            </ul>
          </section>
        );
      })}

      <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-1 border-t border-[var(--color-border)] pt-4 text-sm tabular-nums">
        <dt className="text-[var(--color-muted-foreground)]">Subtotal</dt>
        <dd className="text-right">${subtotal}</dd>
        {orderIntent.taxCents > 0 && (
          <>
            <dt className="text-[var(--color-muted-foreground)]">Tax</dt>
            <dd className="text-right">${tax}</dd>
          </>
        )}
        {orderIntent.feeCents > 0 && (
          <>
            <dt className="text-[var(--color-muted-foreground)]">Fee</dt>
            <dd className="text-right">${fee}</dd>
          </>
        )}
        {orderIntent.tipCents > 0 && (
          <>
            <dt className="text-[var(--color-muted-foreground)]">Tip</dt>
            <dd className="text-right">${tip}</dd>
          </>
        )}
        <dt className="font-semibold">Total</dt>
        <dd className="text-right font-semibold">${total}</dd>
      </dl>
    </div>
  );
}
