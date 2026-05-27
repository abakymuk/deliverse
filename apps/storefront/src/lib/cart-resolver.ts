/**
 * Cart + location resolution helpers (server-only).
 *
 * Critical contract per docs/specs/food-hall-storefront.md §"Cart resolution":
 *
 * - **`getActiveCart` is read-only.** Returns `Cart | null`. Never creates
 *   a row. Used by passive page renders (`cart-link`, `/cart` page,
 *   `/checkout` page, `placeOrderAction`'s pre-check) AND by
 *   `addToCartAction`'s lookup step (to find an existing cart before
 *   deciding whether to create one).
 * - **`getOrCreateActiveCart` is the only mutation path.** Called only
 *   from `addToCartAction` after the validation + cart-location-resolution
 *   flow has determined the right `locationId` for a brand-new cart. If
 *   an active cart already exists, returns it unchanged — the cart owns
 *   its `location_id` and the passed `locationId` is ignored.
 * - **`getDefaultLocation` is brand-aware.** Pass `brandId` to get the
 *   first active location that serves that brand via `location_brands`.
 *   Without `brandId`, falls back to the tenant's first active location
 *   (used by tenant-host paths that aren't yet inside a brand subsection).
 *
 * DEL-25 PR 25b.
 */

import { db } from '@rp/db';
import type { Cart, Location } from '@rp/db';
import { brands, carts, locationBrands, locations } from '@rp/db/schema';
import { and, asc, desc, eq, isNull } from 'drizzle-orm';

/**
 * Read-only. Returns the most-recent `status='active'` cart for
 * `(tenantId, tenantEndUserId)` across any location, or `null` if none.
 *
 * **Never creates a row.** Safe to call from passive page renders.
 *
 * Why no `locationId` filter: the cart owns its location (set on creation).
 * Callers want to find the existing cart regardless of the current
 * request's default location — `addToCartAction` then validates the new
 * line's brand against the cart's `location_id` via `location_brands`.
 */
export async function getActiveCart(
  tenantId: string,
  tenantEndUserId: string,
): Promise<Cart | null> {
  const [row] = await db
    .select()
    .from(carts)
    .where(
      and(
        eq(carts.tenantId, tenantId),
        eq(carts.tenantEndUserId, tenantEndUserId),
        eq(carts.status, 'active'),
        isNull(carts.deletedAt),
      ),
    )
    .orderBy(desc(carts.createdAt))
    .limit(1);
  return row ?? null;
}

/**
 * Mutation path. Returns the existing active cart if one exists (the
 * passed `locationId` is **ignored** in that case — the existing cart's
 * `location_id` wins). If no cart exists, creates a new active cart with
 * the supplied `locationId` and returns it.
 *
 * Called only from `addToCartAction` after server-side validation has
 * determined the correct `locationId` (via `getDefaultLocation(tenantId,
 * brandId)`) for a brand-new cart.
 */
export async function getOrCreateActiveCart(
  tenantId: string,
  tenantEndUserId: string,
  locationId: string,
): Promise<Cart> {
  const existing = await getActiveCart(tenantId, tenantEndUserId);
  if (existing) return existing;

  const [created] = await db
    .insert(carts)
    .values({
      tenantId,
      locationId,
      tenantEndUserId,
      status: 'active',
      fulfillmentType: 'pickup',
    })
    .returning();
  if (!created) {
    throw new Error(
      `failed to create active cart for tenant=${tenantId} user=${tenantEndUserId} location=${locationId}`,
    );
  }
  return created;
}

/**
 * Returns the default location for cart attachment.
 *
 * - With `brandId`: first active location that serves the brand via
 *   `location_brands`. Use this from `addToCartAction` after validating
 *   `menuItemId` produced a `brandId`.
 * - Without `brandId`: first active location for the tenant. Used by
 *   tenant-host food-hall paths that don't yet have a brand context
 *   (e.g., directory render).
 *
 * Throws if no location is available. Should never happen for canonical
 * seed tenants but defensively guarded.
 */
export async function getDefaultLocation(
  tenantId: string,
  brandId?: string,
): Promise<Location> {
  if (brandId) {
    const [loc] = await db
      .select()
      .from(locations)
      .innerJoin(
        locationBrands,
        and(
          eq(locationBrands.locationId, locations.id),
          eq(locationBrands.brandId, brandId),
        ),
      )
      .where(
        and(
          eq(locations.tenantId, tenantId),
          eq(locations.isActive, true),
          isNull(locations.deletedAt),
        ),
      )
      .orderBy(asc(locations.createdAt))
      .limit(1);
    if (loc) return loc.locations;
  }

  const [fallback] = await db
    .select()
    .from(locations)
    .where(
      and(
        eq(locations.tenantId, tenantId),
        eq(locations.isActive, true),
        isNull(locations.deletedAt),
      ),
    )
    .orderBy(asc(locations.createdAt))
    .limit(1);
  if (!fallback) {
    throw new Error(`no active location for tenant ${tenantId}`);
  }
  return fallback;
}

/**
 * Server-side validation: resolves a posted `menuItemId` to its `brandId`,
 * scoped to the resolved tenant (cross-tenant guard).
 *
 * Joins `menu_items → menus → brands` and filters:
 *   - menu_item active + not deleted
 *   - menu active + not deleted
 *   - brand belongs to the resolved tenant (cross-tenant guard)
 *   - brand active + not deleted
 *
 * **No `location_brands` filter at this step.** Cart location resolution
 * happens AFTER validation (because the cart-location-resolution flow
 * depends on knowing the brand first).
 *
 * Returns `{ menuItemId, brandId, priceCents, name }` on success, `null`
 * if any join fails. Caller should treat `null` as adversarial input and
 * throw a generic error.
 *
 * Used by `addToCartAction`.
 */
export async function validateMenuItemForTenant(
  tenantId: string,
  menuItemId: string,
): Promise<{
  menuItemId: string;
  brandId: string;
  brandSlug: string;
  brandName: string;
  name: string;
  priceCents: number;
} | null> {
  // Late imports to keep this file's top-level lean for the page renders
  // that only need the cart helpers. menuItems / menus are referenced by
  // mutation paths only.
  const { menuItems, menus } = await import('@rp/db/schema');
  const [row] = await db
    .select({
      menuItemId: menuItems.id,
      name: menuItems.name,
      priceCents: menuItems.priceCents,
      brandId: brands.id,
      brandSlug: brands.slug,
      brandName: brands.name,
    })
    .from(menuItems)
    .innerJoin(menus, eq(menus.id, menuItems.menuId))
    .innerJoin(brands, eq(brands.id, menus.brandId))
    .where(
      and(
        eq(menuItems.id, menuItemId),
        eq(menuItems.isActive, true),
        isNull(menuItems.deletedAt),
        eq(menus.isActive, true),
        isNull(menus.deletedAt),
        eq(brands.tenantId, tenantId),
        eq(brands.isActive, true),
        isNull(brands.deletedAt),
      ),
    )
    .limit(1);
  return row ?? null;
}
