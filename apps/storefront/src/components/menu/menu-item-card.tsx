import { Card, CardContent } from '@rp/ui/components/card';
import { AddToCartButton } from './add-to-cart-button';

type MenuItemCardProps = {
  menuItemId: string;
  name: string;
  description: string | null;
  priceCents: number;
  /**
   * The page path the menu is rendered on. Passed to the
   * `<AddToCartButton>` form so the server action can compose the
   * `/login?next=<path>` redirect (anonymous users) and revalidate the
   * right page after a successful add. Mode 1/2 brand home: `/`. Mode 3
   * brand subsection: `/b/<slug>`.
   */
  currentPath: string;
};

/**
 * RSC. Single menu item card. Add button is functional in PR 25b — the
 * stub from PR 25a is replaced with `<AddToCartButton>`.
 *
 * docs/specs/food-hall-storefront.md.
 */
export function MenuItemCard({
  menuItemId,
  name,
  description,
  priceCents,
  currentPath,
}: MenuItemCardProps) {
  const price = (priceCents / 100).toFixed(2);
  return (
    <Card>
      <CardContent className="flex items-start justify-between gap-4 p-4">
        <div className="min-w-0 flex-1">
          <h3 className="font-medium">{name}</h3>
          {description && (
            <p className="mt-1 text-sm text-[var(--color-muted-foreground)]">
              {description}
            </p>
          )}
          <p className="mt-2 text-sm font-semibold">${price}</p>
        </div>
        <AddToCartButton menuItemId={menuItemId} currentPath={currentPath} />
      </CardContent>
    </Card>
  );
}
