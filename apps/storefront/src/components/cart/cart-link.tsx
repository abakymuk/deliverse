import Link from 'next/link';
import { db } from '@rp/db';
import { cartItems } from '@rp/db/schema';
import { eq } from 'drizzle-orm';
import { getActiveCart } from '@/lib/cart-resolver';

type CartLinkProps = {
  tenantId: string;
  tenantEndUserId: string | null | undefined;
};

/**
 * RSC. Small "View cart" indicator in the shell header. Calls
 * `getActiveCart` (**read-only** — passive renders never create an empty
 * cart) and shows a count if items exist.
 *
 * For anonymous users (`tenantEndUserId` null/undefined) renders a plain
 * "View cart" link with no count — the cart page itself handles the
 * auth gate + empty state. v1 has no sticky mini-cart.
 *
 * DEL-25 PR 25b.
 */
export async function CartLink({ tenantId, tenantEndUserId }: CartLinkProps) {
  let count = 0;
  if (tenantEndUserId) {
    const cart = await getActiveCart(tenantId, tenantEndUserId);
    if (cart) {
      const [row] = await db
        .select({ id: cartItems.id })
        .from(cartItems)
        .where(eq(cartItems.cartId, cart.id));
      // Sum quantities for accurate "View cart (N)" — light query, cart
      // sizes are tiny.
      const allLines = await db
        .select({ quantity: cartItems.quantity })
        .from(cartItems)
        .where(eq(cartItems.cartId, cart.id));
      count = allLines.reduce((acc, l) => acc + l.quantity, 0);
      // (Keeping the small extra read to avoid a SUM() aggregate query
      // that complicates type inference for a one-off.)
      void row;
    }
  }

  return (
    <Link
      href="/cart"
      className="text-sm font-medium underline-offset-4 hover:underline"
    >
      View cart{count > 0 ? ` (${count})` : ''}
    </Link>
  );
}
