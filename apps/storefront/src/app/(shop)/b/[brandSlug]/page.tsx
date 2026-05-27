import { db } from '@rp/db';
import { brands, locationBrands, locations } from '@rp/db/schema';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { headers } from 'next/headers';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { MenuView } from '@/components/menu/menu-view';
import { brandThemeStyle } from '@/lib/brand-theme';
import { getStorefrontContext } from '@/lib/tenant-resolution';

type Params = { brandSlug: string };

/**
 * Brand subsection inside a tenant-host food-hall storefront. Renders
 * the brand's menu wrapped in a brand-themed container with a breadcrumb
 * back to the food-hall directory.
 *
 * Defense-in-depth: validates `brand.tenant_id === resolvedTenantId` AND
 * the brand is served by the food-hall's first active location.
 * Cross-tenant URL probes (`oomi-kitchen-test.deliverse.app/b/pizza-express`)
 * return 404.
 *
 * Only renders when storefrontType === 'tenant'. Brand-host requests
 * (mode 1/2) get a 404 because their menu already lives at `/`.
 *
 * DEL-25 / docs/specs/food-hall-storefront.md.
 */
export default async function BrandSubsection({
  params,
}: {
  params: Promise<Params>;
}) {
  const { brandSlug } = await params;
  const ctx = await getStorefrontContext();
  if (!ctx) notFound();

  // `/b/<slug>` is a food-hall-only route. On brand-host (mode 1/2)
  // storefronts the menu already renders at `/`, so this path is
  // meaningless and 404s.
  if (ctx.storefrontType !== 'tenant') notFound();

  // Resolve the food-hall's default location (first active, by creation
  // order — matches the directory's resolution).
  const [location] = await db
    .select({ id: locations.id })
    .from(locations)
    .where(
      and(
        eq(locations.tenantId, ctx.tenantId),
        eq(locations.isActive, true),
        isNull(locations.deletedAt),
      ),
    )
    .orderBy(asc(locations.createdAt))
    .limit(1);
  if (!location) notFound();

  // Validate: brand exists, belongs to this tenant (cross-tenant guard),
  // is served by the food-hall's location, is active.
  const [row] = await db
    .select({
      id: brands.id,
      name: brands.name,
      brandingJson: brands.brandingJson,
    })
    .from(brands)
    .innerJoin(
      locationBrands,
      and(
        eq(locationBrands.brandId, brands.id),
        eq(locationBrands.locationId, location.id),
      ),
    )
    .where(
      and(
        eq(brands.slug, brandSlug),
        eq(brands.tenantId, ctx.tenantId),
        eq(brands.isActive, true),
        isNull(brands.deletedAt),
      ),
    )
    .limit(1);
  if (!row) notFound();

  const h = await headers();
  const storefrontName = h.get('x-storefront-name') ?? '';

  return (
    <div
      style={brandThemeStyle(row.brandingJson)}
      className="container mx-auto p-8"
    >
      <div className="mb-6">
        <Link
          href="/"
          className="text-sm text-[var(--color-muted-foreground)] hover:underline"
        >
          ← {storefrontName}
        </Link>
      </div>
      <h1 className="text-4xl font-bold">{row.name}</h1>
      <div className="mt-8">
        <MenuView brandId={row.id} />
      </div>
    </div>
  );
}
