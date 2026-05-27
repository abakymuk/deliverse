import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { BrandDirectory } from '@/components/food-hall/brand-directory';
import { MenuView } from '@/components/menu/menu-view';
import { brandThemeStyle } from '@/lib/brand-theme';
import { getBrandContext, getStorefrontContext } from '@/lib/tenant-resolution';

/**
 * Storefront home — dispatches on storefront type:
 *
 * - `type='brand'`: renders the brand's menu (mode 1/2 — single-brand
 *   storefront at `{brand-slug}.deliverse.app`).
 * - `type='tenant'`: renders the food-hall directory of the tenant's
 *   active brands (mode 3 — `oomi-kitchen-test.deliverse.app`).
 *
 * Per AC#6, mode 3 (food-hall shell) uses tenant defaults; brand themes
 * apply only inside brand subsections (mode 1/2 brand storefronts and
 * `/b/<slug>` routes under a food hall).
 *
 * DEL-25 / docs/specs/food-hall-storefront.md.
 */
export default async function StorefrontHome() {
  const ctx = await getStorefrontContext();
  if (!ctx) notFound();

  if (ctx.storefrontType === 'brand') {
    if (!ctx.brandSlug) notFound();
    const brandCtx = await getBrandContext(ctx.brandSlug);
    if (!brandCtx) notFound();
    return (
      <div
        style={brandThemeStyle(brandCtx.brand.brandingJson)}
        className="container mx-auto p-8"
      >
        <h1 className="text-4xl font-bold">{brandCtx.brand.name}</h1>
        <div className="mt-8">
          <MenuView brandId={brandCtx.brand.id} />
        </div>
      </div>
    );
  }

  // Tenant-host food-hall shell. Uses tenant defaults — no brand theming
  // applied at this level (AC#6).
  const h = await headers();
  const storefrontName = h.get('x-storefront-name') ?? '';
  return (
    <div className="container mx-auto p-8">
      <h1 className="text-4xl font-bold">{storefrontName}</h1>
      <p className="mt-2 text-[var(--color-muted-foreground)]">
        Choose a brand to start your order.
      </p>
      <div className="mt-8">
        <BrandDirectory tenantId={ctx.tenantId} />
      </div>
    </div>
  );
}
