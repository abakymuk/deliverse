import { db } from '@rp/db';
import type { Cart } from '@rp/db';
import { brands, cartItems, menuItems } from '@rp/db/schema';
import { and, asc, eq } from 'drizzle-orm';
import { CartLine } from './cart-line';

type CartSummaryProps = {
  cart: Cart;
  currentPath: string;
};

/**
 * RSC. Loads all line items for a cart and renders them grouped by
 * brand with a running subtotal. Each line is a client component that
 * dispatches qty / remove via server actions.
 *
 * DEL-25 PR 25b.
 */
export async function CartSummary({ cart, currentPath }: CartSummaryProps) {
  // Join cart_items → menu_items → brands so we have everything for
  // rendering in one round-trip. brand from the FK (not snapshot — cart
  // items are transient; the live brand row is what we want for display).
  const lines = await db
    .select({
      cartItemId: cartItems.id,
      quantity: cartItems.quantity,
      unitPriceCents: cartItems.unitPriceCents,
      menuItemName: menuItems.name,
      brandId: brands.id,
      brandName: brands.name,
    })
    .from(cartItems)
    .innerJoin(menuItems, eq(menuItems.id, cartItems.menuItemId))
    .innerJoin(brands, eq(brands.id, cartItems.brandId))
    .where(eq(cartItems.cartId, cart.id))
    .orderBy(asc(brands.name), asc(cartItems.createdAt));

  if (lines.length === 0) {
    return (
      <div className="rounded border border-dashed border-[var(--color-border)] p-8 text-center">
        <p className="text-[var(--color-muted-foreground)]">
          Your cart is empty.
        </p>
      </div>
    );
  }

  // Group by brand (preserves order from the ORDER BY above).
  const byBrand = new Map<
    string,
    { brandName: string; lines: typeof lines }
  >();
  for (const line of lines) {
    const entry = byBrand.get(line.brandId);
    if (entry) {
      entry.lines.push(line);
    } else {
      byBrand.set(line.brandId, { brandName: line.brandName, lines: [line] });
    }
  }

  const subtotalCents = lines.reduce(
    (acc, l) => acc + l.unitPriceCents * l.quantity,
    0,
  );
  const subtotal = (subtotalCents / 100).toFixed(2);

  return (
    <div className="space-y-8">
      {Array.from(byBrand.entries()).map(([brandId, { brandName, lines: brandLines }]) => (
        <section key={brandId}>
          <h2 className="text-xl font-semibold">{brandName}</h2>
          <ul className="mt-2">
            {brandLines.map((l) => (
              <CartLine
                key={l.cartItemId}
                cartItemId={l.cartItemId}
                name={l.menuItemName}
                brandName={l.brandName}
                unitPriceCents={l.unitPriceCents}
                quantity={l.quantity}
                currentPath={currentPath}
              />
            ))}
          </ul>
        </section>
      ))}
      <div className="flex justify-end border-t border-[var(--color-border)] pt-4">
        <p className="text-lg font-semibold tabular-nums">
          Subtotal: ${subtotal}
        </p>
      </div>
    </div>
  );
}
