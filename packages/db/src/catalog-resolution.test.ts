/**
 * Catalog read-path integration test (DEL-34 / X3, AC#3).
 *
 * Proves the catalog spine is queryable and the ModifierSnapshot soft pointers
 * resolve: given a snapshot's `modifierId`, the modifier's `name` +
 * `price_delta_cents` come from the CATALOG (modifiers table), not from the
 * denormalized snapshot copy; and the menu_item ↔ modifier_group link + the
 * item's category resolve.
 *
 * Requires DATABASE_URL (`doppler run --config dev -- pnpm --filter @rp/db test`).
 * Skipped otherwise — keeps `pnpm typecheck` + the pure unit tests fast on
 * machines without doppler. We own the fixtures (throwaway tenant tree, torn
 * down via tenant CASCADE) to avoid coupling to seed.ts state — a CI env can
 * have DATABASE_URL set but not be seeded.
 */

import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { modifierSnapshotSchema, type ModifierSnapshot } from './modifier-snapshot';

// Dynamic imports of ./client + ./schema so vitest can load this file without
// DATABASE_URL (./client throws at module-init when it's unset; with static
// imports, describe.skipIf can't help — the import runs before the skip).
const HAS_DB = !!process.env.DATABASE_URL;

type ClientModule = typeof import('./client');
type SchemaModule = typeof import('./schema');

let clientModule: ClientModule;
let schemaModule: SchemaModule;

let tenantId: string;
let brandId: string;
let menuId: string;
let menuItemId: string;
let categoryId: string;
let groupId: string;
let modifierId: string;

describe.skipIf(!HAS_DB)('catalog read-path resolution (DEL-34 / X3)', () => {
  beforeAll(async () => {
    clientModule = await import('./client');
    schemaModule = await import('./schema');
    const { db } = clientModule;
    const {
      tenants,
      brands,
      menus,
      menuItems,
      categories,
      modifierGroups,
      modifiers,
      menuItemModifierGroups,
    } = schemaModule;

    tenantId = randomUUID();
    brandId = randomUUID();
    menuId = randomUUID();
    menuItemId = randomUUID();
    categoryId = randomUUID();
    groupId = randomUUID();
    modifierId = randomUUID();

    await db.insert(tenants).values({
      id: tenantId,
      slug: `catalog-test-${tenantId.slice(0, 8)}`,
      name: 'Catalog Test Tenant',
    });
    await db.insert(brands).values({
      id: brandId,
      tenantId,
      slug: `catalog-brand-${brandId.slice(0, 8)}`,
      name: 'Catalog Brand',
      brandingJson: {},
    });
    await db.insert(menus).values({ id: menuId, brandId, name: 'Catalog Menu' });
    await db.insert(categories).values({ id: categoryId, brandId, name: 'Mains' });
    await db.insert(menuItems).values({
      id: menuItemId,
      menuId,
      name: 'Test Item',
      priceCents: 1000,
      categoryId,
    });
    await db.insert(modifierGroups).values({
      id: groupId,
      brandId,
      name: 'Size',
      selectionType: 'single',
      minSelect: 1,
      maxSelect: 1,
    });
    await db.insert(modifiers).values({
      id: modifierId,
      modifierGroupId: groupId,
      name: 'Large',
      priceDeltaCents: 200,
      sortOrder: 0,
    });
    await db
      .insert(menuItemModifierGroups)
      .values({ menuItemId, modifierGroupId: groupId });
  });

  afterAll(async () => {
    if (!HAS_DB) return;
    const { db } = clientModule;
    const { tenants } = schemaModule;
    // tenant_id CASCADE tears down brand → menus/menu_items + categories +
    // modifier_groups → modifiers + the join rows.
    await db.delete(tenants).where(eq(tenants.id, tenantId));
  });

  it('resolves modifier name + price_delta from the catalog by modifierId (not the snapshot)', async () => {
    const { db } = clientModule;
    const { modifiers } = schemaModule;

    // A snapshot as persisted on a cart/order line. name + priceDeltaCents are
    // deliberately WRONG here — the catalog is the source of truth, and this
    // test resolves against it, proving we don't trust the denormalized copy.
    const snapshot: ModifierSnapshot = modifierSnapshotSchema.parse({
      modifierGroupId: groupId,
      modifierId,
      name: 'STALE SNAPSHOT NAME',
      priceDeltaCents: -999,
    });

    const [row] = await db
      .select({
        name: modifiers.name,
        priceDeltaCents: modifiers.priceDeltaCents,
      })
      .from(modifiers)
      .where(eq(modifiers.id, snapshot.modifierId))
      .limit(1);

    expect(row).toBeDefined();
    expect(row?.name).toBe('Large');
    expect(row?.priceDeltaCents).toBe(200);
  });

  it('links the menu item to its modifier group via the join table', async () => {
    const { db } = clientModule;
    const { menuItemModifierGroups } = schemaModule;

    const links = await db
      .select({ modifierGroupId: menuItemModifierGroups.modifierGroupId })
      .from(menuItemModifierGroups)
      .where(eq(menuItemModifierGroups.menuItemId, menuItemId));

    expect(links).toHaveLength(1);
    expect(links[0]?.modifierGroupId).toBe(groupId);
  });

  it("resolves the menu item's category through the FK", async () => {
    const { db } = clientModule;
    const { menuItems, categories } = schemaModule;

    const [row] = await db
      .select({ categoryName: categories.name })
      .from(menuItems)
      .innerJoin(categories, eq(categories.id, menuItems.categoryId))
      .where(eq(menuItems.id, menuItemId))
      .limit(1);

    expect(row?.categoryName).toBe('Mains');
  });
});
