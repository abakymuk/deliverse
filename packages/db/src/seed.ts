/**
 * Seed script — bootstrap data for local development.
 *
 * Usage:
 *   doppler run -- pnpm db:seed
 *
 * Dataset (locked by docs/specs/seed-data.md):
 *   - 1 admin (admin@test.local, owner of the seeded tenant)
 *   - 1 tenant (hospitality-group)
 *   - 2 brands (pizza-express, burger-heaven)
 *   - 2 locations (Downtown Kitchen, Eastside Kitchen)
 *   - 2 location_brands rows (Downtown serves both brands — dark-kitchen shape)
 *
 * Idempotent: safe to run repeatedly. Re-runs never duplicate, never error.
 */

import { hashPassword } from '@better-auth/utils/password';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { db } from './client';
import {
  brands,
  locationBrands,
  locations,
  platformAccounts,
  platformUsers,
  storefronts,
  tenantMemberships,
  tenants,
} from './schema';

const DOWNTOWN_LOCATION_ID = '00000000-0000-4000-8000-000000000001';
const EASTSIDE_LOCATION_ID = '00000000-0000-4000-8000-000000000002';

const ADMIN_EMAIL = 'admin@test.local';
const ADMIN_NAME = 'Admin';
const DEFAULT_ADMIN_PASSWORD = 'Admin-Dev-Pass-1';

const TENANT_SLUG = 'hospitality-group';
const TENANT_NAME = 'Hospitality Group';

const BRAND_PIZZA_SLUG = 'pizza-express';
const BRAND_PIZZA_NAME = 'Pizza Express';
const BRAND_BURGER_SLUG = 'burger-heaven';
const BRAND_BURGER_NAME = 'Burger Heaven';

async function seed() {
  const password = process.env.SEED_ADMIN_PASSWORD ?? DEFAULT_ADMIN_PASSWORD;
  const passwordHash = await hashPassword(password);

  // === Admin user ===
  // Partial unique (email WHERE deleted_at IS NULL): no `target` arg so
  // Postgres resolves against any matching constraint including partial uniques.
  await db
    .insert(platformUsers)
    .values({
      email: ADMIN_EMAIL,
      name: ADMIN_NAME,
      emailVerified: true,
    })
    .onConflictDoNothing();

  // Read-back includes isNull(deletedAt) so we never pick up a soft-deleted row.
  const [admin] = await db
    .select({ id: platformUsers.id })
    .from(platformUsers)
    .where(
      and(eq(platformUsers.email, ADMIN_EMAIL), isNull(platformUsers.deletedAt)),
    )
    .limit(1);

  if (!admin) {
    throw new Error(`Failed to insert or find admin user (${ADMIN_EMAIL})`);
  }

  // === Platform account (BA credential shape — providerId singular, accountId = user.id) ===
  // Full composite unique on (provider_id, account_id).
  //
  // DEL-16: was `onConflictDoNothing` — re-running seed with a new
  // `SEED_ADMIN_PASSWORD` would silently keep the old password. Now
  // `onConflictDoUpdate` rotates the password idempotently on every
  // re-seed, so password rotation is just "bump Doppler + re-run pnpm
  // db:seed" without a manual DELETE step.
  await db
    .insert(platformAccounts)
    .values({
      platformUserId: admin.id,
      providerId: 'credential',
      accountId: admin.id,
      password: passwordHash,
    })
    .onConflictDoUpdate({
      target: [platformAccounts.providerId, platformAccounts.accountId],
      set: {
        password: passwordHash,
        updatedAt: sql`now()`,
      },
    });

  // === Tenant ===
  // Partial unique on slug WHERE deleted_at IS NULL.
  await db
    .insert(tenants)
    .values({
      slug: TENANT_SLUG,
      name: TENANT_NAME,
      status: 'active',
    })
    .onConflictDoNothing();

  const [tenant] = await db
    .select({ id: tenants.id })
    .from(tenants)
    .where(and(eq(tenants.slug, TENANT_SLUG), isNull(tenants.deletedAt)))
    .limit(1);

  if (!tenant) {
    throw new Error(`Failed to insert or find tenant (${TENANT_SLUG})`);
  }

  // === Membership ===
  // Composite unique on (platform_user_id, tenant_id).
  await db
    .insert(tenantMemberships)
    .values({
      platformUserId: admin.id,
      tenantId: tenant.id,
      role: 'owner',
    })
    .onConflictDoNothing({
      target: [tenantMemberships.platformUserId, tenantMemberships.tenantId],
    });

  // === Brands ===
  // Partial unique on slug WHERE deleted_at IS NULL.
  await db
    .insert(brands)
    .values([
      {
        tenantId: tenant.id,
        slug: BRAND_PIZZA_SLUG,
        name: BRAND_PIZZA_NAME,
        isActive: true,
        brandingJson: {},
      },
      {
        tenantId: tenant.id,
        slug: BRAND_BURGER_SLUG,
        name: BRAND_BURGER_NAME,
        isActive: true,
        brandingJson: {},
      },
    ])
    .onConflictDoNothing();

  const brandRows = await db
    .select({ id: brands.id, slug: brands.slug })
    .from(brands)
    .where(and(eq(brands.tenantId, tenant.id), isNull(brands.deletedAt)));

  const pizza = brandRows.find((b) => b.slug === BRAND_PIZZA_SLUG);
  const burger = brandRows.find((b) => b.slug === BRAND_BURGER_SLUG);

  if (!pizza || !burger) {
    throw new Error('Failed to find seeded brands');
  }

  // === Locations ===
  // No natural unique key; idempotency via deterministic UUID PKs.
  await db
    .insert(locations)
    .values([
      {
        id: DOWNTOWN_LOCATION_ID,
        tenantId: tenant.id,
        name: 'Downtown Kitchen',
        addressLine1: '100 Main St',
        city: 'Brooklyn',
        state: 'NY',
        postalCode: '11201',
        country: 'US',
      },
      {
        id: EASTSIDE_LOCATION_ID,
        tenantId: tenant.id,
        name: 'Eastside Kitchen',
        addressLine1: '250 East Ave',
        city: 'Brooklyn',
        state: 'NY',
        postalCode: '11215',
        country: 'US',
      },
    ])
    .onConflictDoNothing({ target: locations.id });

  // === Location-brand links (dark-kitchen shape: Downtown serves both brands) ===
  // Composite PK (location_id, brand_id).
  await db
    .insert(locationBrands)
    .values([
      { locationId: DOWNTOWN_LOCATION_ID, brandId: pizza.id },
      { locationId: DOWNTOWN_LOCATION_ID, brandId: burger.id },
    ])
    .onConflictDoNothing({
      target: [locationBrands.locationId, locationBrands.brandId],
    });

  // === Storefronts (DEL-19) ===
  // One brand storefront per seeded brand; type='brand', primary_brand_id set.
  // Partial unique on slug WHERE deleted_at IS NULL.
  await db
    .insert(storefronts)
    .values([
      {
        tenantId: tenant.id,
        slug: BRAND_PIZZA_SLUG,
        name: BRAND_PIZZA_NAME,
        type: 'brand',
        primaryBrandId: pizza.id,
        brandingJson: {},
        isActive: true,
      },
      {
        tenantId: tenant.id,
        slug: BRAND_BURGER_SLUG,
        name: BRAND_BURGER_NAME,
        type: 'brand',
        primaryBrandId: burger.id,
        brandingJson: {},
        isActive: true,
      },
    ])
    .onConflictDoNothing();

  console.info(
    `Seeded admin=${ADMIN_EMAIL} (${admin.id}), tenant=${TENANT_SLUG} (${tenant.id}), brands=[${BRAND_PIZZA_SLUG}, ${BRAND_BURGER_SLUG}], locations=[Downtown, Eastside], storefronts=[${BRAND_PIZZA_SLUG}, ${BRAND_BURGER_SLUG}]`,
  );

  // === Test-only fixtures (DEL-8) ===
  // Gated on SEED_TEST_FIXTURES=1 so the canonical seed stays minimal for
  // staging/prd. CI's e2e job sets the flag to provision a second tenant
  // needed by the storefront tenant-isolation Playwright test.
  if (process.env.SEED_TEST_FIXTURES === '1') {
    await db
      .insert(tenants)
      .values({
        slug: 'other-co-test',
        name: 'Other Co (Test)',
        status: 'active',
      })
      .onConflictDoNothing();

    const [otherTenant] = await db
      .select({ id: tenants.id })
      .from(tenants)
      .where(and(eq(tenants.slug, 'other-co-test'), isNull(tenants.deletedAt)))
      .limit(1);

    if (otherTenant) {
      await db
        .insert(brands)
        .values({
          tenantId: otherTenant.id,
          slug: 'other-brand-test',
          name: 'Other Brand (Test)',
          isActive: true,
          brandingJson: {},
        })
        .onConflictDoNothing();

      // DEL-19: read back the test brand id, then seed its storefront row.
      // The brand insert above is `onConflictDoNothing`, so we can't rely on
      // `RETURNING` — same read-back pattern as the canonical brands above.
      const [otherBrand] = await db
        .select({ id: brands.id })
        .from(brands)
        .where(
          and(
            eq(brands.tenantId, otherTenant.id),
            eq(brands.slug, 'other-brand-test'),
            isNull(brands.deletedAt),
          ),
        )
        .limit(1);

      if (otherBrand) {
        await db
          .insert(storefronts)
          .values({
            tenantId: otherTenant.id,
            slug: 'other-brand-test',
            name: 'Other Brand (Test)',
            type: 'brand',
            primaryBrandId: otherBrand.id,
            brandingJson: {},
            isActive: true,
          })
          .onConflictDoNothing();
      }

      console.info(
        `Seeded test fixtures: tenant=other-co-test (${otherTenant.id}), brand=other-brand-test, storefront=other-brand-test`,
      );
    }
  }
}

seed()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Seed failed:', err);
    process.exit(1);
  });
