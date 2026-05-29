/**
 * Seed script — bootstrap data for local development.
 *
 * Usage:
 *   doppler run -- pnpm db:seed
 *
 * Dataset (locked by docs/specs/seed-data.md + docs/specs/commerce-schema-v1.md +
 * docs/specs/food-hall-storefront.md):
 *
 *   Hospitality Group (mode-1/2 brand storefronts):
 *     - 1 admin (admin@test.local, owner of hospitality-group)
 *     - 1 tenant (hospitality-group)
 *     - 2 brands (pizza-express, burger-heaven)
 *     - 2 locations (Downtown Kitchen, Eastside Kitchen)
 *     - 2 location_brands rows (Downtown serves both brands — dark-kitchen)
 *     - 2 storefronts (one per brand — DEL-19)
 *     - 2 menus (one per brand — DEL-24)
 *     - 4 menu_items (2 per menu — DEL-24)
 *
 *   OOMI Kitchen (mode-3 food-hall demo — DEL-25):
 *     - 1 tenant (oomi-kitchen-test)
 *     - 2 brands (oomi-burger-test, oomi-pizza-test)
 *     - 1 location (oomi-kitchen — single location for food-hall v1)
 *     - 2 location_brands rows (dark-kitchen — one location serves both brands)
 *     - 3 storefronts (1 tenant-type entry + 2 brand-type)
 *     - 2 menus (one per OOMI brand)
 *     - 4 menu_items (2 per menu)
 *
 * Test fixtures (gated on SEED_TEST_FIXTURES=1):
 *   - 1 secondary tenant (other-co-test) with brand + storefront (DEL-8)
 *   - 1 single-brand tenant (solo-cafe-test) — Mode-1 coverage fixture
 *     with brand + location + storefront + menu + 1 item (DEL-26)
 *   - 1 test end-user (cart-test@deliverse.test) under hospitality-group (DEL-24)
 *   - 1 multi-brand cart with 2 cart_items (mixed brand_id) for that user (DEL-24)
 *
 * Idempotent: safe to run repeatedly. Re-runs never duplicate, never error.
 *
 * Seed snapshots are insert-only (`onConflictDoNothing`). Re-running after
 * editing canonical menu_item prices does NOT rotate priceCents. Switch to
 * `onConflictDoUpdate` (precedent: platformAccounts at line ~83) if price
 * rotation becomes a need.
 */

import { hashPassword } from '@better-auth/utils/password';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db } from './client';
import {
  brands,
  cartItems,
  carts,
  categories,
  locationBrands,
  locations,
  menuItemModifierGroups,
  menuItems,
  menus,
  modifierGroups,
  modifiers,
  platformAccounts,
  platformUsers,
  storefronts,
  tenantEndUsers,
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

// DEL-24: deterministic UUIDs for the canonical commerce dataset and the
// SEED_TEST_FIXTURES multi-brand cart fixture. Pattern matches the
// locations IDs above — keeps the seed idempotent without depending on
// partial-unique constraints (menus / menu_items / carts / cart_items
// have no natural unique key).
const PIZZA_MENU_ID = '00000000-0000-4000-8000-000000000010';
const BURGER_MENU_ID = '00000000-0000-4000-8000-000000000011';
const PIZZA_ITEM_MARGHERITA_ID = '00000000-0000-4000-8000-000000000020';
const PIZZA_ITEM_PEPPERONI_ID = '00000000-0000-4000-8000-000000000021';
const BURGER_ITEM_CLASSIC_ID = '00000000-0000-4000-8000-000000000022';
const BURGER_ITEM_CHEESE_ID = '00000000-0000-4000-8000-000000000023';

// SEED_TEST_FIXTURES (DEL-24) — multi-brand cart fixture.
const CART_TEST_USER_EMAIL = 'cart-test@deliverse.test';
const CART_TEST_USER_NAME = 'Cart Test User';
const CART_FIXTURE_ID = '00000000-0000-4000-8000-000000000030';
const CART_ITEM_PIZZA_ID = '00000000-0000-4000-8000-000000000040';
const CART_ITEM_BURGER_ID = '00000000-0000-4000-8000-000000000041';

// DEL-25: OOMI Kitchen demo tenant (canonical seed — ships to stg/prd).
// `-test` suffix matches the established quarantine convention
// (`other-co-test`, `other-brand-test`) and reserves the bare
// `oomi-kitchen` slug for any future real customer. Decision logged in
// docs/specs/food-hall-storefront.md § "Intentional Deviation from AC#7".
const OOMI_TENANT_SLUG = 'oomi-kitchen-test';
// ASCII-only — the storefront proxy injects this as an HTTP header
// (`x-storefront-name`), which requires ByteString-encodable values (< 256).
// Any non-ASCII char (em-dash, etc.) crashes the proxy with "Cannot convert
// argument to a ByteString".
const OOMI_TENANT_NAME = 'OOMI Kitchen Test';
const OOMI_BURGER_SLUG = 'oomi-burger-test';
const OOMI_BURGER_NAME = 'OOMI Burger';
const OOMI_PIZZA_SLUG = 'oomi-pizza-test';
const OOMI_PIZZA_NAME = 'OOMI Pizza';
// Deterministic UUIDs for the OOMI dataset (range 50–73 to avoid
// collisions with the hospitality-group + DEL-24 cart-fixture UUIDs).
const OOMI_LOCATION_ID = '00000000-0000-4000-8000-000000000050';
const OOMI_BURGER_MENU_ID = '00000000-0000-4000-8000-000000000060';
const OOMI_PIZZA_MENU_ID = '00000000-0000-4000-8000-000000000061';
const OOMI_BURGER_ITEM_SMASH_ID = '00000000-0000-4000-8000-000000000070';
const OOMI_BURGER_ITEM_TRUFFLE_ID = '00000000-0000-4000-8000-000000000071';
const OOMI_PIZZA_ITEM_MARGHERITA_ID = '00000000-0000-4000-8000-000000000072';
const OOMI_PIZZA_ITEM_TRUFFLE_ID = '00000000-0000-4000-8000-000000000073';
// Distinct primary colors for the OOMI brand themes so the brand
// subsections are visibly different from the food-hall shell defaults.
const OOMI_BURGER_PRIMARY_HEX = '#dc2626'; // warm red — burger
const OOMI_PIZZA_PRIMARY_HEX = '#16a34a'; // green — pizza

// DEL-26: solo-cafe-test — single-brand tenant fixture for Mode-1 coverage
// (SEED_TEST_FIXTURES-gated, not canonical). Used by
// apps/storefront/tests/e2e/mode-1-single-brand.spec.ts; documented in
// docs/specs/food-hall-test-matrix.md. Slug doubles as tenant + brand +
// storefront slug — the degenerate single-brand shape per ADR-0012
// (storefront == brand == tenant entry point when there's only one brand).
// UUID range 80–93 leaves headroom past 0–73 (hospitality-group + OOMI +
// DEL-24 cart fixture).
const SOLO_TENANT_SLUG = 'solo-cafe-test';
const SOLO_TENANT_NAME = 'Solo Cafe Test';
const SOLO_BRAND_SLUG = 'solo-cafe-test';
const SOLO_BRAND_NAME = 'Solo Cafe';
const SOLO_LOCATION_ID = '00000000-0000-4000-8000-000000000080';
const SOLO_MENU_ID = '00000000-0000-4000-8000-000000000081';
const SOLO_ITEM_ESPRESSO_ID = '00000000-0000-4000-8000-000000000082';

// DEL-34 / X3: catalog UUIDs (range a0+ — past the 0–93 block above). Per
// brand: a category + a single-select "Size" modifier group (the 3 size
// modifiers are inlined in the insert). Join rows use the composite PK.
const PIZZA_CATEGORY_ID = '00000000-0000-4000-8000-0000000000a0';
const PIZZA_SIZE_GROUP_ID = '00000000-0000-4000-8000-0000000000a1';
const BURGER_CATEGORY_ID = '00000000-0000-4000-8000-0000000000b0';
const BURGER_SIZE_GROUP_ID = '00000000-0000-4000-8000-0000000000b1';
const OOMI_BURGER_CATEGORY_ID = '00000000-0000-4000-8000-0000000000c0';
const OOMI_BURGER_SIZE_GROUP_ID = '00000000-0000-4000-8000-0000000000c1';
const OOMI_PIZZA_CATEGORY_ID = '00000000-0000-4000-8000-0000000000d0';
const OOMI_PIZZA_SIZE_GROUP_ID = '00000000-0000-4000-8000-0000000000d1';

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

  // === Menus + menu_items (DEL-24) ===
  // One menu per brand, two items per menu. No natural unique key on these
  // tables — idempotency via deterministic UUID PKs (matches locations
  // pattern above). Seed snapshots are insert-only — see file header.
  await db
    .insert(menus)
    .values([
      {
        id: PIZZA_MENU_ID,
        brandId: pizza.id,
        name: 'Pizza Menu',
        description: 'Wood-fired pies and sides.',
        isActive: true,
      },
      {
        id: BURGER_MENU_ID,
        brandId: burger.id,
        name: 'Burger Menu',
        description: 'Smash burgers and fries.',
        isActive: true,
      },
    ])
    .onConflictDoNothing({ target: menus.id });

  await db
    .insert(menuItems)
    .values([
      {
        id: PIZZA_ITEM_MARGHERITA_ID,
        menuId: PIZZA_MENU_ID,
        name: 'Margherita',
        description: 'Tomato, mozzarella, basil.',
        priceCents: 1400,
        isActive: true,
      },
      {
        id: PIZZA_ITEM_PEPPERONI_ID,
        menuId: PIZZA_MENU_ID,
        name: 'Pepperoni',
        description: 'Tomato, mozzarella, pepperoni.',
        priceCents: 1600,
        isActive: true,
      },
      {
        id: BURGER_ITEM_CLASSIC_ID,
        menuId: BURGER_MENU_ID,
        name: 'Classic Burger',
        description: 'Beef, lettuce, tomato, onion.',
        priceCents: 1200,
        isActive: true,
      },
      {
        id: BURGER_ITEM_CHEESE_ID,
        menuId: BURGER_MENU_ID,
        name: 'Cheeseburger',
        description: 'Classic + American cheese.',
        priceCents: 1400,
        isActive: true,
      },
    ])
    .onConflictDoNothing({ target: menuItems.id });

  console.info(
    `Seeded admin=${ADMIN_EMAIL} (${admin.id}), tenant=${TENANT_SLUG} (${tenant.id}), brands=[${BRAND_PIZZA_SLUG}, ${BRAND_BURGER_SLUG}], locations=[Downtown, Eastside], storefronts=[${BRAND_PIZZA_SLUG}, ${BRAND_BURGER_SLUG}], menus=[Pizza, Burger], menu_items=4`,
  );

  // === OOMI Kitchen — canonical food-hall demo tenant (DEL-25) ===
  //
  // mode-3 showcase tenant. Lives in canonical seed (not SEED_TEST_FIXTURES)
  // per the M3 Definition of Done: "live for one tenant in prd". `-test`
  // suffix quarantines from real customer data and reserves the bare
  // `oomi-kitchen` slug for any future real customer.
  await db
    .insert(tenants)
    .values({
      slug: OOMI_TENANT_SLUG,
      name: OOMI_TENANT_NAME,
      status: 'active',
    })
    .onConflictDoNothing();

  const [oomiTenant] = await db
    .select({ id: tenants.id })
    .from(tenants)
    .where(and(eq(tenants.slug, OOMI_TENANT_SLUG), isNull(tenants.deletedAt)))
    .limit(1);

  if (!oomiTenant) {
    throw new Error(
      `Failed to insert or find OOMI tenant (${OOMI_TENANT_SLUG})`,
    );
  }

  // OOMI brands — distinct primary colors so brand subsections are
  // visibly different from the tenant-shell defaults.
  await db
    .insert(brands)
    .values([
      {
        tenantId: oomiTenant.id,
        slug: OOMI_BURGER_SLUG,
        name: OOMI_BURGER_NAME,
        isActive: true,
        brandingJson: { primary: OOMI_BURGER_PRIMARY_HEX },
      },
      {
        tenantId: oomiTenant.id,
        slug: OOMI_PIZZA_SLUG,
        name: OOMI_PIZZA_NAME,
        isActive: true,
        brandingJson: { primary: OOMI_PIZZA_PRIMARY_HEX },
      },
    ])
    .onConflictDoNothing();

  const oomiBrandRows = await db
    .select({ id: brands.id, slug: brands.slug })
    .from(brands)
    .where(and(eq(brands.tenantId, oomiTenant.id), isNull(brands.deletedAt)));

  const oomiBurger = oomiBrandRows.find((b) => b.slug === OOMI_BURGER_SLUG);
  const oomiPizza = oomiBrandRows.find((b) => b.slug === OOMI_PIZZA_SLUG);

  if (!oomiBurger || !oomiPizza) {
    throw new Error('Failed to find seeded OOMI brands');
  }

  // OOMI location — single location for food-hall v1 (multi-location
  // food halls are a non-goal per DEL-25).
  await db
    .insert(locations)
    .values({
      id: OOMI_LOCATION_ID,
      tenantId: oomiTenant.id,
      name: 'OOMI Kitchen',
      addressLine1: '500 Food Hall Plaza',
      city: 'Brooklyn',
      state: 'NY',
      postalCode: '11201',
      country: 'US',
    })
    .onConflictDoNothing({ target: locations.id });

  // OOMI location_brands — dark-kitchen: one physical kitchen serves
  // both OOMI brands.
  await db
    .insert(locationBrands)
    .values([
      { locationId: OOMI_LOCATION_ID, brandId: oomiBurger.id },
      { locationId: OOMI_LOCATION_ID, brandId: oomiPizza.id },
    ])
    .onConflictDoNothing({
      target: [locationBrands.locationId, locationBrands.brandId],
    });

  // OOMI storefronts — 1 tenant-type (food-hall entry, no primary_brand_id)
  // + 2 brand-type (so individual brand subdomains also work in mode-2).
  // Same tenant owns all three; cart spans brands within tenant.
  await db
    .insert(storefronts)
    .values([
      {
        tenantId: oomiTenant.id,
        slug: OOMI_TENANT_SLUG,
        name: OOMI_TENANT_NAME,
        type: 'tenant',
        primaryBrandId: null,
        brandingJson: {},
        isActive: true,
      },
      {
        tenantId: oomiTenant.id,
        slug: OOMI_BURGER_SLUG,
        name: OOMI_BURGER_NAME,
        type: 'brand',
        primaryBrandId: oomiBurger.id,
        brandingJson: { primary: OOMI_BURGER_PRIMARY_HEX },
        isActive: true,
      },
      {
        tenantId: oomiTenant.id,
        slug: OOMI_PIZZA_SLUG,
        name: OOMI_PIZZA_NAME,
        type: 'brand',
        primaryBrandId: oomiPizza.id,
        brandingJson: { primary: OOMI_PIZZA_PRIMARY_HEX },
        isActive: true,
      },
    ])
    .onConflictDoNothing();

  // OOMI menus — one per brand
  await db
    .insert(menus)
    .values([
      {
        id: OOMI_BURGER_MENU_ID,
        brandId: oomiBurger.id,
        name: 'OOMI Burger Menu',
        description: 'Smash burgers and sides.',
        isActive: true,
      },
      {
        id: OOMI_PIZZA_MENU_ID,
        brandId: oomiPizza.id,
        name: 'OOMI Pizza Menu',
        description: 'Wood-fired pies and sides.',
        isActive: true,
      },
    ])
    .onConflictDoNothing({ target: menus.id });

  // OOMI menu items
  await db
    .insert(menuItems)
    .values([
      {
        id: OOMI_BURGER_ITEM_SMASH_ID,
        menuId: OOMI_BURGER_MENU_ID,
        name: 'Smash Burger',
        description: 'Beef, lettuce, tomato, onion.',
        priceCents: 1300,
        isActive: true,
      },
      {
        id: OOMI_BURGER_ITEM_TRUFFLE_ID,
        menuId: OOMI_BURGER_MENU_ID,
        name: 'Truffle Burger',
        description: 'Truffle mayo, mushroom, swiss.',
        priceCents: 1700,
        isActive: true,
      },
      {
        id: OOMI_PIZZA_ITEM_MARGHERITA_ID,
        menuId: OOMI_PIZZA_MENU_ID,
        name: 'Margherita',
        description: 'Tomato, mozzarella, basil.',
        priceCents: 1400,
        isActive: true,
      },
      {
        id: OOMI_PIZZA_ITEM_TRUFFLE_ID,
        menuId: OOMI_PIZZA_MENU_ID,
        name: 'Truffle Pizza',
        description: 'Truffle oil, mushroom, ricotta.',
        priceCents: 1900,
        isActive: true,
      },
    ])
    .onConflictDoNothing({ target: menuItems.id });

  // DEL-25 one-off convergence — if a previous run inserted the OOMI rows
  // with a non-ASCII name (em-dash variant), the storefront proxy crashes
  // when it tries to inject the name as an HTTP header. `onConflictDoNothing`
  // above would leave the stale name in place forever. Idempotent UPDATEs
  // converge any prior rows to the current ASCII name. No-op on rows that
  // already have the right name. Safe to leave in seed.ts permanently.
  await db
    .update(tenants)
    .set({ name: OOMI_TENANT_NAME, updatedAt: sql`now()` })
    .where(and(eq(tenants.slug, OOMI_TENANT_SLUG), isNull(tenants.deletedAt)));
  await db
    .update(storefronts)
    .set({ name: OOMI_TENANT_NAME, updatedAt: sql`now()` })
    .where(
      and(
        eq(storefronts.slug, OOMI_TENANT_SLUG),
        eq(storefronts.type, 'tenant'),
        isNull(storefronts.deletedAt),
      ),
    );

  console.info(
    `Seeded OOMI Kitchen demo tenant: tenant=${OOMI_TENANT_SLUG} (${oomiTenant.id}), brands=[${OOMI_BURGER_SLUG}, ${OOMI_PIZZA_SLUG}], location=oomi-kitchen, storefronts=[${OOMI_TENANT_SLUG}(tenant), ${OOMI_BURGER_SLUG}(brand), ${OOMI_PIZZA_SLUG}(brand)], menus=[OOMI Burger Menu, OOMI Pizza Menu], menu_items=4`,
  );

  // === Catalog spine (DEL-34 / X3) ===
  // Canonical (ships to stg/prd) — gives the hospitality + OOMI showcase items
  // real categories + a "Size" modifier group, so the ModifierSnapshot soft
  // pointers have a source of truth. Per brand: 1 category + a single-select
  // Size group (3 sizes). SAME-BRAND only (the DB doesn't enforce it).
  // Idempotent via deterministic UUID PKs + onConflictDoNothing.
  await db
    .insert(categories)
    .values([
      { id: PIZZA_CATEGORY_ID, brandId: pizza.id, name: 'Pizzas' },
      { id: BURGER_CATEGORY_ID, brandId: burger.id, name: 'Burgers' },
      { id: OOMI_BURGER_CATEGORY_ID, brandId: oomiBurger.id, name: 'Burgers' },
      { id: OOMI_PIZZA_CATEGORY_ID, brandId: oomiPizza.id, name: 'Pizzas' },
    ])
    .onConflictDoNothing({ target: categories.id });

  await db
    .insert(modifierGroups)
    .values([
      { id: PIZZA_SIZE_GROUP_ID, brandId: pizza.id, name: 'Size', selectionType: 'single', minSelect: 1, maxSelect: 1 },
      { id: BURGER_SIZE_GROUP_ID, brandId: burger.id, name: 'Size', selectionType: 'single', minSelect: 1, maxSelect: 1 },
      { id: OOMI_BURGER_SIZE_GROUP_ID, brandId: oomiBurger.id, name: 'Size', selectionType: 'single', minSelect: 1, maxSelect: 1 },
      { id: OOMI_PIZZA_SIZE_GROUP_ID, brandId: oomiPizza.id, name: 'Size', selectionType: 'single', minSelect: 1, maxSelect: 1 },
    ])
    .onConflictDoNothing({ target: modifierGroups.id });

  await db
    .insert(modifiers)
    .values([
      // Pizza Express — Size
      { id: '00000000-0000-4000-8000-0000000000a2', modifierGroupId: PIZZA_SIZE_GROUP_ID, name: 'Small', priceDeltaCents: -100, sortOrder: 0 },
      { id: '00000000-0000-4000-8000-0000000000a3', modifierGroupId: PIZZA_SIZE_GROUP_ID, name: 'Regular', priceDeltaCents: 0, isDefault: true, sortOrder: 1 },
      { id: '00000000-0000-4000-8000-0000000000a4', modifierGroupId: PIZZA_SIZE_GROUP_ID, name: 'Large', priceDeltaCents: 200, sortOrder: 2 },
      // Burger Heaven — Size (patty count)
      { id: '00000000-0000-4000-8000-0000000000b2', modifierGroupId: BURGER_SIZE_GROUP_ID, name: 'Single', priceDeltaCents: 0, isDefault: true, sortOrder: 0 },
      { id: '00000000-0000-4000-8000-0000000000b3', modifierGroupId: BURGER_SIZE_GROUP_ID, name: 'Double', priceDeltaCents: 250, sortOrder: 1 },
      { id: '00000000-0000-4000-8000-0000000000b4', modifierGroupId: BURGER_SIZE_GROUP_ID, name: 'Triple', priceDeltaCents: 500, sortOrder: 2 },
      // OOMI Burger — Size (patty count)
      { id: '00000000-0000-4000-8000-0000000000c2', modifierGroupId: OOMI_BURGER_SIZE_GROUP_ID, name: 'Single', priceDeltaCents: 0, isDefault: true, sortOrder: 0 },
      { id: '00000000-0000-4000-8000-0000000000c3', modifierGroupId: OOMI_BURGER_SIZE_GROUP_ID, name: 'Double', priceDeltaCents: 250, sortOrder: 1 },
      { id: '00000000-0000-4000-8000-0000000000c4', modifierGroupId: OOMI_BURGER_SIZE_GROUP_ID, name: 'Triple', priceDeltaCents: 500, sortOrder: 2 },
      // OOMI Pizza — Size
      { id: '00000000-0000-4000-8000-0000000000d2', modifierGroupId: OOMI_PIZZA_SIZE_GROUP_ID, name: 'Small', priceDeltaCents: -100, sortOrder: 0 },
      { id: '00000000-0000-4000-8000-0000000000d3', modifierGroupId: OOMI_PIZZA_SIZE_GROUP_ID, name: 'Regular', priceDeltaCents: 0, isDefault: true, sortOrder: 1 },
      { id: '00000000-0000-4000-8000-0000000000d4', modifierGroupId: OOMI_PIZZA_SIZE_GROUP_ID, name: 'Large', priceDeltaCents: 200, sortOrder: 2 },
    ])
    .onConflictDoNothing({ target: modifiers.id });

  // Attach each brand's Size group to that brand's items (composite-PK idempotent).
  await db
    .insert(menuItemModifierGroups)
    .values([
      { menuItemId: PIZZA_ITEM_MARGHERITA_ID, modifierGroupId: PIZZA_SIZE_GROUP_ID },
      { menuItemId: PIZZA_ITEM_PEPPERONI_ID, modifierGroupId: PIZZA_SIZE_GROUP_ID },
      { menuItemId: BURGER_ITEM_CLASSIC_ID, modifierGroupId: BURGER_SIZE_GROUP_ID },
      { menuItemId: BURGER_ITEM_CHEESE_ID, modifierGroupId: BURGER_SIZE_GROUP_ID },
      { menuItemId: OOMI_BURGER_ITEM_SMASH_ID, modifierGroupId: OOMI_BURGER_SIZE_GROUP_ID },
      { menuItemId: OOMI_BURGER_ITEM_TRUFFLE_ID, modifierGroupId: OOMI_BURGER_SIZE_GROUP_ID },
      { menuItemId: OOMI_PIZZA_ITEM_MARGHERITA_ID, modifierGroupId: OOMI_PIZZA_SIZE_GROUP_ID },
      { menuItemId: OOMI_PIZZA_ITEM_TRUFFLE_ID, modifierGroupId: OOMI_PIZZA_SIZE_GROUP_ID },
    ])
    .onConflictDoNothing();

  // Assign each item to its brand's category (idempotent UPDATEs — additive
  // migration left category_id NULL on existing rows).
  await db.update(menuItems).set({ categoryId: PIZZA_CATEGORY_ID })
    .where(inArray(menuItems.id, [PIZZA_ITEM_MARGHERITA_ID, PIZZA_ITEM_PEPPERONI_ID]));
  await db.update(menuItems).set({ categoryId: BURGER_CATEGORY_ID })
    .where(inArray(menuItems.id, [BURGER_ITEM_CLASSIC_ID, BURGER_ITEM_CHEESE_ID]));
  await db.update(menuItems).set({ categoryId: OOMI_BURGER_CATEGORY_ID })
    .where(inArray(menuItems.id, [OOMI_BURGER_ITEM_SMASH_ID, OOMI_BURGER_ITEM_TRUFFLE_ID]));
  await db.update(menuItems).set({ categoryId: OOMI_PIZZA_CATEGORY_ID })
    .where(inArray(menuItems.id, [OOMI_PIZZA_ITEM_MARGHERITA_ID, OOMI_PIZZA_ITEM_TRUFFLE_ID]));

  console.info(
    'Seeded catalog (DEL-34 / X3): 4 categories, 4 modifier groups, 12 modifiers, 8 item↔group links',
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

    // === DEL-26: solo-cafe-test — single-brand tenant fixture (Mode-1) ===
    // Test-only (SEED_TEST_FIXTURES-gated). Provides the canonical Mode-1
    // (single-brand tenant) shape per ADR-0012 §"Supported modes" — one
    // tenant, one brand, one storefront, one location, one menu, one item.
    // Read-only in the test: `mode-1-single-brand.spec.ts` resolves these
    // rows in `beforeAll` and exercises the routing + adapter + disclosure
    // invariants. Idempotency via partial-unique constraints + deterministic
    // UUIDs (matches other-co-test + OOMI patterns).
    await db
      .insert(tenants)
      .values({
        slug: SOLO_TENANT_SLUG,
        name: SOLO_TENANT_NAME,
        status: 'active',
      })
      .onConflictDoNothing();

    const [soloTenant] = await db
      .select({ id: tenants.id })
      .from(tenants)
      .where(and(eq(tenants.slug, SOLO_TENANT_SLUG), isNull(tenants.deletedAt)))
      .limit(1);

    if (soloTenant) {
      // Single brand — the degenerate Mode-1 shape: storefront ≡ brand ≡
      // tenant entry point.
      await db
        .insert(brands)
        .values({
          tenantId: soloTenant.id,
          slug: SOLO_BRAND_SLUG,
          name: SOLO_BRAND_NAME,
          isActive: true,
          brandingJson: {},
        })
        .onConflictDoNothing();

      const [soloBrand] = await db
        .select({ id: brands.id })
        .from(brands)
        .where(
          and(
            eq(brands.tenantId, soloTenant.id),
            eq(brands.slug, SOLO_BRAND_SLUG),
            isNull(brands.deletedAt),
          ),
        )
        .limit(1);

      if (soloBrand) {
        await db
          .insert(locations)
          .values({
            id: SOLO_LOCATION_ID,
            tenantId: soloTenant.id,
            name: 'Solo Cafe Kitchen',
            addressLine1: '1 Solo Street',
            city: 'Brooklyn',
            state: 'NY',
            postalCode: '11201',
            country: 'US',
          })
          .onConflictDoNothing({ target: locations.id });

        await db
          .insert(locationBrands)
          .values({ locationId: SOLO_LOCATION_ID, brandId: soloBrand.id })
          .onConflictDoNothing({
            target: [locationBrands.locationId, locationBrands.brandId],
          });

        // One brand storefront. slug == tenant slug == brand slug because
        // there's only one brand to surface.
        await db
          .insert(storefronts)
          .values({
            tenantId: soloTenant.id,
            slug: SOLO_TENANT_SLUG,
            name: SOLO_BRAND_NAME,
            type: 'brand',
            primaryBrandId: soloBrand.id,
            brandingJson: {},
            isActive: true,
          })
          .onConflictDoNothing();

        await db
          .insert(menus)
          .values({
            id: SOLO_MENU_ID,
            brandId: soloBrand.id,
            name: 'Solo Cafe Menu',
            description: 'Espresso and pastries.',
            isActive: true,
          })
          .onConflictDoNothing({ target: menus.id });

        await db
          .insert(menuItems)
          .values({
            id: SOLO_ITEM_ESPRESSO_ID,
            menuId: SOLO_MENU_ID,
            name: 'House Espresso',
            description: 'Single origin, double shot.',
            priceCents: 450,
            isActive: true,
          })
          .onConflictDoNothing({ target: menuItems.id });

        console.info(
          `Seeded DEL-26 fixture: tenant=${SOLO_TENANT_SLUG} (${soloTenant.id}), brand=${SOLO_BRAND_SLUG}, location=Solo Cafe Kitchen, storefront=${SOLO_TENANT_SLUG}(brand), menu=Solo Cafe Menu, menu_items=1`,
        );
      }
    }

    // === DEL-24: multi-brand cart fixture under hospitality-group ===
    // AC#7 demands "at least one tenant has multiple brands sharing one cart
    // with mixed brand_id line items." This block sets up exactly that. It
    // attaches to the canonical hospitality-group tenant (already has pizza
    // + burger brands sharing Downtown location), so no new tenant is needed.
    //
    // Test end-user uses bare onConflictDoNothing() because tenant_end_users
    // has a partial-unique index on (tenant_id, email) WHERE deleted_at IS
    // NULL — matches the platformUsers pattern above.
    await db
      .insert(tenantEndUsers)
      .values({
        tenantId: tenant.id,
        email: CART_TEST_USER_EMAIL,
        name: CART_TEST_USER_NAME,
        emailVerified: true,
      })
      .onConflictDoNothing();

    const [cartTestUser] = await db
      .select({ id: tenantEndUsers.id })
      .from(tenantEndUsers)
      .where(
        and(
          eq(tenantEndUsers.tenantId, tenant.id),
          eq(tenantEndUsers.email, CART_TEST_USER_EMAIL),
          isNull(tenantEndUsers.deletedAt),
        ),
      )
      .limit(1);

    if (cartTestUser) {
      // One cart, two cart_items (mixed brand_id). Deterministic UUIDs for
      // idempotency.
      await db
        .insert(carts)
        .values({
          id: CART_FIXTURE_ID,
          tenantId: tenant.id,
          locationId: DOWNTOWN_LOCATION_ID,
          tenantEndUserId: cartTestUser.id,
          status: 'active',
          fulfillmentType: 'pickup',
        })
        .onConflictDoNothing({ target: carts.id });

      await db
        .insert(cartItems)
        .values([
          {
            id: CART_ITEM_PIZZA_ID,
            cartId: CART_FIXTURE_ID,
            brandId: pizza.id,
            menuItemId: PIZZA_ITEM_MARGHERITA_ID,
            quantity: 1,
            unitPriceCents: 1400,
          },
          {
            id: CART_ITEM_BURGER_ID,
            cartId: CART_FIXTURE_ID,
            brandId: burger.id,
            menuItemId: BURGER_ITEM_CLASSIC_ID,
            quantity: 1,
            unitPriceCents: 1200,
          },
        ])
        .onConflictDoNothing({ target: cartItems.id });

      console.info(
        `Seeded DEL-24 fixture: cart=${CART_FIXTURE_ID} under ${TENANT_SLUG} for ${CART_TEST_USER_EMAIL}, cart_items=[pizza:${BRAND_PIZZA_SLUG}, burger:${BRAND_BURGER_SLUG}]`,
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
