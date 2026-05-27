import { Button } from '@rp/ui/components/button';
import { Card, CardContent } from '@rp/ui/components/card';

type MenuItemCardProps = {
  name: string;
  description: string | null;
  priceCents: number;
};

/**
 * RSC. Single menu item card.
 *
 * DEL-25 PR 25a: the "Add" button is a disabled stub. PR 25b replaces it
 * with a functional `<AddToCartButton>` client component that calls the
 * `addToCartAction` server action.
 *
 * docs/specs/food-hall-storefront.md.
 */
export function MenuItemCard({
  name,
  description,
  priceCents,
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
        {/* PR 25b replaces this stub with <AddToCartButton menuItemId={...} brandSlug={...} /> */}
        <Button disabled aria-disabled className="self-center">
          Add
        </Button>
      </CardContent>
    </Card>
  );
}
