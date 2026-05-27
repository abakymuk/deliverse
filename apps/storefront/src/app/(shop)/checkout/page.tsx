import { headers } from 'next/headers';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { auth } from '@/lib/auth';
import { CartSummary } from '@/components/cart/cart-summary';
import { CheckoutForm } from '@/components/checkout/checkout-form';
import { getActiveCart } from '@/lib/cart-resolver';
import { getStorefrontContext } from '@/lib/tenant-resolution';

/**
 * /checkout — order placement.
 *
 * RSC. Resolves session + storefront context. Reads active cart
 * (read-only via `getActiveCart`; passive renders never create empty
 * carts). If null, redirects to `/cart` (the empty-state UI lives there).
 *
 * Renders the cart preview (qty controls still work — users can adjust
 * before placing the order) + `<CheckoutForm>` (fulfillment picker +
 * Place order button posting to `placeOrderAction`).
 *
 * `/checkout` is in the proxy's PROTECTED_PATHS so unauthenticated GETs
 * redirect to `/login` before this page runs; the in-page session check
 * is defense-in-depth.
 *
 * DEL-25 PR 25c / docs/specs/food-hall-storefront.md.
 */
export default async function CheckoutPage() {
  const ctx = await getStorefrontContext();
  if (!ctx) notFound();

  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user) {
    notFound();
  }

  const cart = await getActiveCart(ctx.tenantId, session.user.id);
  if (!cart) {
    redirect('/cart');
  }

  return (
    <div className="container mx-auto p-8">
      <div className="mb-6">
        <Link
          href="/cart"
          className="text-sm text-[var(--color-muted-foreground)] hover:underline"
        >
          ← Back to cart
        </Link>
      </div>
      <h1 className="text-4xl font-bold">Checkout</h1>
      <div className="mt-8">
        <CartSummary cart={cart} currentPath="/checkout" />
      </div>
      <div className="mt-8 max-w-sm">
        <CheckoutForm />
      </div>
    </div>
  );
}
