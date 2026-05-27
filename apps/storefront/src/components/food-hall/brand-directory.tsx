import { db } from '@rp/db';
import { brands, locationBrands, locations } from '@rp/db/schema';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { BrandCard } from './brand-card';

type BrandDirectoryProps = {
  tenantId: string;
};

/**
 * RSC. Renders a grid of active brand cards for a tenant-host food-hall
 * storefront. Brands are filtered to those served by the food-hall's
 * default location (v1: the tenant's first active location, since
 * multi-location food halls are a non-goal per DEL-25).
 *
 * DEL-25 / docs/specs/food-hall-storefront.md.
 */
export async function BrandDirectory({ tenantId }: BrandDirectoryProps) {
  // Resolve the food-hall's default location (first active, by creation order).
  const [location] = await db
    .select({ id: locations.id })
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

  if (!location) {
    return (
      <p className="text-[var(--color-muted-foreground)]">
        No locations available for this tenant.
      </p>
    );
  }

  // Load brands served by this location (active + non-deleted).
  const brandRows = await db
    .select({
      id: brands.id,
      slug: brands.slug,
      name: brands.name,
      brandingJson: brands.brandingJson,
    })
    .from(brands)
    .innerJoin(locationBrands, eq(locationBrands.brandId, brands.id))
    .where(
      and(
        eq(locationBrands.locationId, location.id),
        eq(brands.isActive, true),
        isNull(brands.deletedAt),
      ),
    )
    .orderBy(asc(brands.name));

  if (brandRows.length === 0) {
    return (
      <p className="text-[var(--color-muted-foreground)]">
        No brands available at this location.
      </p>
    );
  }

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {brandRows.map((b) => (
        <BrandCard
          key={b.id}
          slug={b.slug}
          name={b.name}
          branding={b.brandingJson}
        />
      ))}
    </div>
  );
}
