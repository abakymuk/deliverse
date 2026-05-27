import { expect, test } from '@playwright/test';
import { db } from '@rp/db';
import { storefronts, tenants } from '@rp/db/schema';
import { and, eq, isNull } from 'drizzle-orm';

/**
 * DEL-20 — Storefront-aware host resolution.
 *
 * Covers all 7 ACs from the issue with explicit attention to AC#5 (brand-host
 * unchanged) and AC#6 (tenant-host returns 200 from stub). The header-spoof
 * cases (5, 6) prove the strip-before-branch defense the spec commits to.
 *
 * Fixture: this suite creates an OOMI Kitchen Test tenant + type='tenant'
 * storefront in beforeAll and deletes the tenant (cascading the storefront)
 * in afterAll. The canonical seed.ts is intentionally NOT modified — fixture
 * lifecycle lives here, slug `-test` suffixed to avoid collision with any
 * future real OOMI Kitchen seeded via DEL-25.
 *
 * Spec: docs/specs/storefront-host-resolution.md
 */

const STOREFRONT_PORT = 3001;
const PIZZA_BRAND_SLUG = 'pizza-express';
const OOMI_TENANT_SLUG = 'oomi-kitchen-test';
const OOMI_STOREFRONT_SLUG = 'oomi-kitchen-test';
const RESERVED_SUBDOMAIN = 'admin';
const UNKNOWN_SUBDOMAIN = 'nonexistent';

function urlFor(slug: string, path: string): string {
  return `http://${slug}.localhost:${STOREFRONT_PORT}${path}`;
}

// Serial: shared beforeAll/afterAll fixture (OOMI Kitchen Test tenant + storefront).
// Mirrors the storefront-tenant-scoping.spec.ts serialization rationale —
// parallel workers would race teardown.
test.describe
  .serial('DEL-20 — storefront-aware host resolution', () => {
    let oomiTenantId: string;

    test.beforeAll(async () => {
      await db
        .insert(tenants)
        .values({ slug: OOMI_TENANT_SLUG, name: 'OOMI Kitchen Test', status: 'active' })
        .onConflictDoNothing();

      const [tenantRow] = await db
        .select({ id: tenants.id })
        .from(tenants)
        .where(and(eq(tenants.slug, OOMI_TENANT_SLUG), isNull(tenants.deletedAt)))
        .limit(1);
      if (!tenantRow) throw new Error(`tenant ${OOMI_TENANT_SLUG} not created`);
      oomiTenantId = tenantRow.id;

      await db
        .insert(storefronts)
        .values({
          tenantId: oomiTenantId,
          slug: OOMI_STOREFRONT_SLUG,
          name: 'OOMI Kitchen Test',
          type: 'tenant',
          primaryBrandId: null,
          brandingJson: {},
          isActive: true,
        })
        .onConflictDoNothing();
    });

    test.afterAll(async () => {
      // Cascade deletes the storefront via FK ON DELETE CASCADE on tenant_id.
      await db.delete(tenants).where(eq(tenants.id, oomiTenantId));
    });

    test('1. brand host renders existing home with brand heading (AC#5)', async ({
      request,
    }) => {
      const res = await request.get(urlFor(PIZZA_BRAND_SLUG, '/'));
      expect(res.status()).toBe(200);
      const body = await res.text();
      expect(body).toContain('Pizza Express');
    });

    test('2. tenant host renders food-hall stub with storefront name (AC#6)', async ({
      request,
    }) => {
      const res = await request.get(urlFor(OOMI_STOREFRONT_SLUG, '/'));
      expect(res.status()).toBe(200);
      const body = await res.text();
      expect(body).toContain('OOMI Kitchen Test');
      expect(body).toContain('Food hall');
      expect(body).toContain('coming soon');
    });

    test('3. reserved subdomain bypasses storefront resolution (AC#7)', async ({ request }) => {
      const res = await request.get(urlFor(RESERVED_SUBDOMAIN, '/'));
      expect(res.status()).toBe(200);
      // Dev-helpful message, unchanged from pre-DEL-20.
      expect(await res.text()).toContain('No brand specified');
    });

    test('4. unknown subdomain returns 404', async ({ request }) => {
      const res = await request.get(urlFor(UNKNOWN_SUBDOMAIN, '/'));
      expect(res.status()).toBe(404);
    });

    test('5. brand-host header-spoof: client-supplied x-storefront-type is stripped, brand UI renders', async ({
      request,
    }) => {
      const res = await request.get(urlFor(PIZZA_BRAND_SLUG, '/'), {
        headers: {
          'x-storefront-type': 'tenant',
          'x-storefront-name': 'Evil Hall',
        },
      });
      expect(res.status()).toBe(200);
      const body = await res.text();
      expect(body).toContain('Pizza Express');
      expect(body).not.toContain('Evil Hall');
      expect(body).not.toContain('Food hall');
    });

    test('6. unknown-host header-spoof: stripped headers, page 404s (critical strip-before-branch case)', async ({
      request,
    }) => {
      const res = await request.get(urlFor(UNKNOWN_SUBDOMAIN, '/'), {
        headers: {
          'x-storefront-type': 'tenant',
          'x-storefront-name': 'Evil Hall',
        },
      });
      expect(res.status()).toBe(404);
    });
  });
