import { db } from '@rp/db';
import { menuItems, menus } from '@rp/db/schema';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { MenuItemCard } from './menu-item-card';

type MenuViewProps = {
  brandId: string;
};

/**
 * RSC. Renders a brand's active menus + menu_items.
 *
 * Shared between mode 1/2 (brand storefront home, `(shop)/page.tsx` when
 * storefrontType==='brand') and mode 3 (brand subsection inside a food
 * hall, `(shop)/b/[brandSlug]/page.tsx`).
 *
 * DEL-25 / docs/specs/food-hall-storefront.md.
 */
export async function MenuView({ brandId }: MenuViewProps) {
  // Load active menus for this brand.
  const brandMenus = await db
    .select({
      id: menus.id,
      name: menus.name,
      description: menus.description,
    })
    .from(menus)
    .where(
      and(
        eq(menus.brandId, brandId),
        eq(menus.isActive, true),
        isNull(menus.deletedAt),
      ),
    )
    .orderBy(asc(menus.createdAt));

  if (brandMenus.length === 0) {
    return (
      <p className="text-[var(--color-muted-foreground)]">
        No menus available.
      </p>
    );
  }

  // Load all active items across these menus in one query.
  const menuIds = brandMenus.map((m) => m.id);
  const items = await db
    .select({
      id: menuItems.id,
      menuId: menuItems.menuId,
      name: menuItems.name,
      description: menuItems.description,
      priceCents: menuItems.priceCents,
    })
    .from(menuItems)
    .where(
      and(
        inArray(menuItems.menuId, menuIds),
        eq(menuItems.isActive, true),
        isNull(menuItems.deletedAt),
      ),
    )
    .orderBy(asc(menuItems.createdAt));

  // Group items by menu for render-time lookup.
  const itemsByMenu = new Map<string, typeof items>();
  for (const item of items) {
    const existing = itemsByMenu.get(item.menuId);
    if (existing) {
      existing.push(item);
    } else {
      itemsByMenu.set(item.menuId, [item]);
    }
  }

  return (
    <div className="space-y-8">
      {brandMenus.map((m) => (
        <section key={m.id}>
          <h2 className="text-2xl font-semibold">{m.name}</h2>
          {m.description && (
            <p className="mt-1 text-sm text-[var(--color-muted-foreground)]">
              {m.description}
            </p>
          )}
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            {(itemsByMenu.get(m.id) ?? []).map((item) => (
              <MenuItemCard
                key={item.id}
                name={item.name}
                description={item.description}
                priceCents={item.priceCents}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
