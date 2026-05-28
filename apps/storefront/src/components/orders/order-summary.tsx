import { db } from '@rp/db';
import type { Order } from '@rp/db';
import { orderLineItems } from '@rp/db/schema';
import { asc, eq } from 'drizzle-orm';

type OrderSummaryProps = {
  order: Order;
};

/**
 * RSC. Renders the line items + totals for an order, grouped by brand.
 *
 * Uses snapshot columns (`brand_name_snapshot`, `name_snapshot`, snapshot
 * prices) rather than joining live brand/menu_item rows. Per DEL-24:
 *
 * - `order_line_items.brand_id` is `ON DELETE SET NULL` — if the brand is
 *   removed, the FK clears but `brand_name_snapshot` preserves identity.
 * - `menu_item_id_snapshot` is a soft pointer (no FK) — survives menu
 *   item hard-delete.
 *
 * The snapshot-first read keeps order detail rendering stable across
 * post-checkout brand/menu mutations.
 *
 * DEL-25 PR 25c.
 */
export async function OrderSummary({ order }: OrderSummaryProps) {
  const lines = await db
    .select({
      id: orderLineItems.id,
      brandNameSnapshot: orderLineItems.brandNameSnapshot,
      nameSnapshot: orderLineItems.nameSnapshot,
      quantity: orderLineItems.quantity,
      unitPriceCents: orderLineItems.unitPriceCents,
      totalCents: orderLineItems.totalCents,
    })
    .from(orderLineItems)
    .where(eq(orderLineItems.orderId, order.id))
    .orderBy(asc(orderLineItems.brandNameSnapshot));

  // Group by brand name (snapshot — preserves grouping even after brand
  // soft/hard delete).
  const byBrand = new Map<string, typeof lines>();
  for (const line of lines) {
    const existing = byBrand.get(line.brandNameSnapshot);
    if (existing) {
      existing.push(line);
    } else {
      byBrand.set(line.brandNameSnapshot, [line]);
    }
  }

  const subtotal = (order.subtotalCents / 100).toFixed(2);
  const tax = (order.taxCents / 100).toFixed(2);
  const fee = (order.feeCents / 100).toFixed(2);
  const tip = (order.tipCents / 100).toFixed(2);
  const total = (order.totalCents / 100).toFixed(2);

  return (
    <div className="space-y-8">
      <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-1 text-sm">
        <dt className="text-[var(--color-muted-foreground)]">Status</dt>
        <dd className="font-medium capitalize">{order.status}</dd>
        <dt className="text-[var(--color-muted-foreground)]">Fulfillment</dt>
        <dd className="font-medium capitalize">{order.fulfillmentType}</dd>
        <dt className="text-[var(--color-muted-foreground)]">Placed</dt>
        <dd className="font-medium">
          {order.createdAt instanceof Date
            ? order.createdAt.toLocaleString()
            : new Date(order.createdAt).toLocaleString()}
        </dd>
      </dl>

      {Array.from(byBrand.entries()).map(([brandName, brandLines]) => (
        <section key={brandName}>
          <h2 className="text-xl font-semibold">{brandName}</h2>
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
      ))}

      <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-1 border-t border-[var(--color-border)] pt-4 text-sm tabular-nums">
        <dt className="text-[var(--color-muted-foreground)]">Subtotal</dt>
        <dd className="text-right">${subtotal}</dd>
        {order.taxCents > 0 && (
          <>
            <dt className="text-[var(--color-muted-foreground)]">Tax</dt>
            <dd className="text-right">${tax}</dd>
          </>
        )}
        {order.feeCents > 0 && (
          <>
            <dt className="text-[var(--color-muted-foreground)]">Fee</dt>
            <dd className="text-right">${fee}</dd>
          </>
        )}
        {order.tipCents > 0 && (
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
