'use server';

import { db } from '@rp/db';
import { cartItems, carts, locationBrands } from '@rp/db/schema';
import { safeNextPath } from '@rp/auth-core/safe-next-path';
import { and, eq, isNull } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth';
import {
  getActiveCart,
  getDefaultLocation,
  getOrCreateActiveCart,
  validateMenuItemForTenant,
} from '@/lib/cart-resolver';
import { resolveStorefrontTenantContext } from '@/lib/storefront-tenant-context';

/**
 * DEL-25 PR 25b — cart server actions.
 *
 * Authoritative flow per docs/specs/food-hall-storefront.md §"Server-side
 * input validation + cart location resolution":
 *
 *   1. Resolve storefront context → `tenantId` only.
 *   2. Read BA session → `tenantEndUserId`. If absent, redirect to
 *      `/login?next=<sanitized currentPath>`.
 *   3. Validate posted input row chain server-side (cross-tenant guard).
 *   4. For `addToCartAction`: look up existing cart (read-only) →
 *      resolve cart location → mutate via `getOrCreateActiveCart`.
 *      For update/remove: never create; verify cart ownership via
 *      cart_items → carts join.
 *   5. Apply DB mutation.
 *   6. Revalidate `/cart` + the rendering RSC's `currentPath`.
 *
 * Cross-cutting:
 * - **currentPath is an explicit hidden form field** filled by the RSC
 *   that rendered the form. Server actions don't reliably see the
 *   originating pathname from headers.
 * - **safeNextPath sanitizes** before composing the login redirect or
 *   the revalidate path — rejects external URLs, double-slash
 *   protocol-relatives, etc.
 * - **Cross-tenant + cross-user guards on every mutation.** A forged
 *   `menuItemId` or `cartItemId` from another tenant gets a `null` from
 *   the validation query, and the action throws a generic error rather
 *   than leaking constraint details.
 */

function readCurrentPath(formData: FormData): string {
  const raw = formData.get('currentPath');
  return typeof raw === 'string' ? raw : '/';
}

function readString(formData: FormData, key: string): string | null {
  const raw = formData.get(key);
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
}

function readPositiveInt(
  formData: FormData,
  key: string,
  fallback: number,
): number {
  const raw = formData.get(key);
  if (typeof raw !== 'string') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

/**
 * Adds a menu item to the user's active cart, creating the cart if none
 * exists. Implements the full validate → resolve-location → mutate flow.
 */
export async function addToCartAction(formData: FormData): Promise<void> {
  const currentPath = readCurrentPath(formData);
  const menuItemId = readString(formData, 'menuItemId');
  const quantity = readPositiveInt(formData, 'quantity', 1);
  if (!menuItemId) {
    throw new Error('addToCartAction: missing menuItemId');
  }

  // 1. Storefront context → tenantId. Do NOT resolve a location yet —
  // we need the brand from the menu item first.
  const ctx = await resolveStorefrontTenantContext();

  // 2. Session check. Anonymous → login redirect with sanitized next.
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user) {
    const safe = safeNextPath(currentPath, '/cart');
    redirect(`/login?next=${encodeURIComponent(safe)}`);
  }
  const tenantEndUserId = session.user.id;

  // 3. Validate menu_item → menus → brands, filtered by resolved tenant.
  // Zero rows ⇒ adversarial input. Throw generic error.
  const item = await validateMenuItemForTenant(ctx.tenantId, menuItemId);
  if (!item) {
    throw new Error('addToCartAction: item unavailable');
  }

  // 4. Existing cart lookup (read-only).
  const existingCart = await getActiveCart(ctx.tenantId, tenantEndUserId);

  // 5. Cart location resolution.
  let cartId: string;
  if (existingCart) {
    // Verify the validated brand is served at the existing cart's
    // location_id via location_brands. Edge case for v1 single-location
    // food halls but the guard is cheap.
    const [served] = await db
      .select({ brandId: locationBrands.brandId })
      .from(locationBrands)
      .where(
        and(
          eq(locationBrands.locationId, existingCart.locationId),
          eq(locationBrands.brandId, item.brandId),
        ),
      )
      .limit(1);
    if (!served) {
      throw new Error(
        'addToCartAction: item unavailable at your cart\'s location',
      );
    }
    cartId = existingCart.id;
  } else {
    // New cart — pick the brand-aware default location.
    const location = await getDefaultLocation(ctx.tenantId, item.brandId);
    const newCart = await getOrCreateActiveCart(
      ctx.tenantId,
      tenantEndUserId,
      location.id,
    );
    cartId = newCart.id;
  }

  // 6. Insert the cart_item with snapshot price.
  await db.insert(cartItems).values({
    cartId,
    brandId: item.brandId,
    menuItemId: item.menuItemId,
    quantity,
    unitPriceCents: item.priceCents,
  });

  // 7. Revalidate the cart page + the rendering route (sanitized).
  revalidatePath('/cart');
  const safeRevalidate = safeNextPath(currentPath, '/');
  revalidatePath(safeRevalidate);
}

/**
 * Adjusts the quantity of an existing cart_item. Never creates a cart.
 * Verifies the cart belongs to the session user within the resolved
 * tenant (cross-tenant + cross-user guard).
 */
export async function updateCartItemQuantityAction(
  formData: FormData,
): Promise<void> {
  const currentPath = readCurrentPath(formData);
  const cartItemId = readString(formData, 'cartItemId');
  const quantity = readPositiveInt(formData, 'quantity', 0);
  if (!cartItemId) {
    throw new Error('updateCartItemQuantityAction: missing cartItemId');
  }
  if (quantity <= 0) {
    throw new Error(
      'updateCartItemQuantityAction: quantity must be positive (use removeCartItemAction to delete)',
    );
  }

  const ctx = await resolveStorefrontTenantContext();
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user) {
    const safe = safeNextPath(currentPath, '/cart');
    redirect(`/login?next=${encodeURIComponent(safe)}`);
  }
  const tenantEndUserId = session.user.id;

  // Verify ownership via cart_items → carts join.
  const [target] = await db
    .select({ id: cartItems.id })
    .from(cartItems)
    .innerJoin(carts, eq(carts.id, cartItems.cartId))
    .where(
      and(
        eq(cartItems.id, cartItemId),
        eq(carts.tenantId, ctx.tenantId),
        eq(carts.tenantEndUserId, tenantEndUserId),
        eq(carts.status, 'active'),
        isNull(carts.deletedAt),
      ),
    )
    .limit(1);
  if (!target) {
    throw new Error('updateCartItemQuantityAction: cart item not found');
  }

  await db
    .update(cartItems)
    .set({ quantity })
    .where(eq(cartItems.id, cartItemId));

  revalidatePath('/cart');
  const safeRevalidate = safeNextPath(currentPath, '/');
  revalidatePath(safeRevalidate);
}

/**
 * Deletes a cart_item. Same ownership guard as the quantity action.
 * Never creates a cart.
 */
export async function removeCartItemAction(formData: FormData): Promise<void> {
  const currentPath = readCurrentPath(formData);
  const cartItemId = readString(formData, 'cartItemId');
  if (!cartItemId) {
    throw new Error('removeCartItemAction: missing cartItemId');
  }

  const ctx = await resolveStorefrontTenantContext();
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user) {
    const safe = safeNextPath(currentPath, '/cart');
    redirect(`/login?next=${encodeURIComponent(safe)}`);
  }
  const tenantEndUserId = session.user.id;

  const [target] = await db
    .select({ id: cartItems.id })
    .from(cartItems)
    .innerJoin(carts, eq(carts.id, cartItems.cartId))
    .where(
      and(
        eq(cartItems.id, cartItemId),
        eq(carts.tenantId, ctx.tenantId),
        eq(carts.tenantEndUserId, tenantEndUserId),
        eq(carts.status, 'active'),
        isNull(carts.deletedAt),
      ),
    )
    .limit(1);
  if (!target) {
    throw new Error('removeCartItemAction: cart item not found');
  }

  await db.delete(cartItems).where(eq(cartItems.id, cartItemId));

  revalidatePath('/cart');
  const safeRevalidate = safeNextPath(currentPath, '/');
  revalidatePath(safeRevalidate);
}
