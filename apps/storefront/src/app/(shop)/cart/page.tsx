import { headers } from 'next/headers';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { auth } from '@/lib/auth';
import { CartSummary } from '@/components/cart/cart-summary';
import { getActiveCart } from '@/lib/cart-resolver';
import { getStorefrontContext } from '@/lib/tenant-resolution';

/**
 * /cart — unified cart page.
 *
 * RSC. Resolves storefront context + BA session. The storefront proxy
 * adds `/cart` to PROTECTED_PATHS so unauthenticated requests are
 * redirected to `/login` before this page runs; the in-page check is
 * defense-in-depth.
 *
 * Calls `getActiveCart` (read-only — never creates an empty cart on
 * visit). If `null`, renders an "Your cart is empty" state with a link
 * back to the storefront home. Otherwise hands off to `<CartSummary>`.
 *
 * DEL-25 PR 25b / docs/specs/food-hall-storefront.md.
 */
export default async function CartPage() {
  const ctx = await getStorefrontContext();
  if (!ctx) notFound();

  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user) {
    // Proxy should already have redirected, but if anything slipped:
    notFound();
  }

  const cart = await getActiveCart(ctx.tenantId, session.user.id);

  return (
    <div className="container mx-auto p-8">
      <h1 className="text-4xl font-bold">Your cart</h1>

      {cart ? (
        <div className="mt-8">
          <CartSummary cart={cart} currentPath="/cart" />
        </div>
      ) : (
        <div className="mt-8 rounded border border-dashed border-[var(--color-border)] p-8 text-center">
          <p className="text-[var(--color-muted-foreground)]">
            Your cart is empty.
          </p>
          <p className="mt-4">
            <Link
              href="/"
              className="text-sm underline underline-offset-4 hover:no-underline"
            >
              ← Back to the menu
            </Link>
          </p>
        </div>
      )}
    </div>
  );
}
