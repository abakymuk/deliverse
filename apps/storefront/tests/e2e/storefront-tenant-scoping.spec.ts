import { expect, test } from '@playwright/test';
import { db } from '@rp/db';
import { brands, tenantEndUserSessions, tenantEndUsers, tenants } from '@rp/db/schema';
import { and, eq, isNull } from 'drizzle-orm';

/**
 * DEL-3 integration tests — storefront tenant-scoped adapter.
 *
 * Covers Linear AC #4 (positive + sibling-brand + cross-tenant) and AC #5
 * (negative: no resolvable brand context). Drives via Playwright's
 * `request` fixture (no browser). DB assertions via `@rp/db`.
 *
 * Seed prerequisite: `doppler run -- pnpm db:seed` (idempotent — creates
 * Hospitality Group + pizza-express + burger-heaven). Test 3 inserts a
 * second tenant ("Other Co" + "other-brand") via Drizzle in `beforeAll`
 * and tears it down in `afterAll`; that keeps `seed.ts` canonical.
 *
 * Spec: docs/specs/storefront-tenant-scoping.md §7.1.
 */

const STOREFRONT_PORT = 3001;
const HOSPITALITY_TENANT_SLUG = 'hospitality-group';
const PIZZA_BRAND_SLUG = 'pizza-express';
const BURGER_BRAND_SLUG = 'burger-heaven';
const OTHER_TENANT_SLUG = 'other-co-del3-test';
const OTHER_BRAND_SLUG = 'other-brand-del3-test';

function urlFor(brandSlug: string, path: string): string {
  return `http://${brandSlug}.localhost:${STOREFRONT_PORT}${path}`;
}

function nonce(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function resolveTenantId(slug: string): Promise<string> {
  const [row] = await db
    .select({ id: tenants.id })
    .from(tenants)
    .where(and(eq(tenants.slug, slug), isNull(tenants.deletedAt)))
    .limit(1);
  if (!row) throw new Error(`tenant slug "${slug}" not found — seed first`);
  return row.id;
}

async function resolveBrandId(slug: string): Promise<string> {
  const [row] = await db
    .select({ id: brands.id })
    .from(brands)
    .where(and(eq(brands.slug, slug), isNull(brands.deletedAt)))
    .limit(1);
  if (!row) throw new Error(`brand slug "${slug}" not found — seed first`);
  return row.id;
}

// Serial: the cross-tenant test relies on a shared `beforeAll` / `afterAll`
// fixture (Other Co tenant + other-brand). Parallel workers would race on
// the teardown — worker B's `afterAll` would delete the fixture while
// worker C is mid-test. Single worker, one fixture lifecycle.
test.describe
  .serial('DEL-3 — storefront tenant scoping', () => {
    let hospitalityTenantId: string;
    let pizzaBrandId: string;
    let otherTenantId: string;
    let otherBrandId: string;

    test.beforeAll(async () => {
      hospitalityTenantId = await resolveTenantId(HOSPITALITY_TENANT_SLUG);
      pizzaBrandId = await resolveBrandId(PIZZA_BRAND_SLUG);

      // Insert second tenant + brand for the cross-tenant isolation test.
      // Idempotent via partial-unique conflict targets (matches seed.ts shape).
      await db
        .insert(tenants)
        .values({ slug: OTHER_TENANT_SLUG, name: 'Other Co (DEL-3 test)', status: 'active' })
        .onConflictDoNothing();
      otherTenantId = await resolveTenantId(OTHER_TENANT_SLUG);

      await db
        .insert(brands)
        .values({
          tenantId: otherTenantId,
          slug: OTHER_BRAND_SLUG,
          name: 'Other Brand (DEL-3 test)',
          isActive: true,
          brandingJson: {},
        })
        .onConflictDoNothing();
      otherBrandId = await resolveBrandId(OTHER_BRAND_SLUG);
    });

    test.afterAll(async () => {
      // Cascade delete removes brand + any tenant_end_users + sessions.
      await db.delete(tenants).where(eq(tenants.id, otherTenantId));
    });

    test('AC #4 positive — signup at pizza-express stamps Hospitality Group tenant_id', async ({
      request,
    }) => {
      const email = `t+pizza-${nonce()}@del3.local`;
      const res = await request.post(urlFor(PIZZA_BRAND_SLUG, '/api/auth/sign-up/email'), {
        data: { name: 'Pizza Test', email, password: 'test-pass-12chars' },
        headers: { Origin: `http://${PIZZA_BRAND_SLUG}.localhost:${STOREFRONT_PORT}` },
      });

      expect(res.status(), `signup body: ${await res.text()}`).toBe(200);

      const [user] = await db
        .select({ id: tenantEndUsers.id, tenantId: tenantEndUsers.tenantId })
        .from(tenantEndUsers)
        .where(and(eq(tenantEndUsers.email, email), isNull(tenantEndUsers.deletedAt)))
        .limit(1);
      if (!user) throw new Error(`user row not written for ${email}`);
      expect(user.tenantId).toBe(hospitalityTenantId);

      const [session] = await db
        .select({ currentBrandId: tenantEndUserSessions.currentBrandId })
        .from(tenantEndUserSessions)
        .where(eq(tenantEndUserSessions.tenantEndUserId, user.id))
        .limit(1);
      if (!session) throw new Error('session row not written');
      expect(session.currentBrandId).toBe(pizzaBrandId);
    });

    test('AC #4 sibling-brand — same email at burger-heaven (same tenant) does not duplicate the user row', async ({
      request,
    }) => {
      const email = `t+sibling-${nonce()}@del3.local`;

      const first = await request.post(urlFor(PIZZA_BRAND_SLUG, '/api/auth/sign-up/email'), {
        data: { name: 'First', email, password: 'test-pass-12chars' },
        headers: { Origin: `http://${PIZZA_BRAND_SLUG}.localhost:${STOREFRONT_PORT}` },
      });
      expect(first.status(), 'first signup must succeed').toBe(200);

      const second = await request.post(urlFor(BURGER_BRAND_SLUG, '/api/auth/sign-up/email'), {
        data: { name: 'Second', email, password: 'test-pass-12chars' },
        headers: { Origin: `http://${BURGER_BRAND_SLUG}.localhost:${STOREFRONT_PORT}` },
      });
      expect(second.status(), `second signup body: ${await second.text()}`).toBeGreaterThanOrEqual(
        400,
      );

      const rows = await db
        .select({ id: tenantEndUsers.id, tenantId: tenantEndUsers.tenantId })
        .from(tenantEndUsers)
        .where(and(eq(tenantEndUsers.email, email), isNull(tenantEndUsers.deletedAt)));
      expect(rows.length, 'expected exactly one user row (same tenant)').toBe(1);
      const [row] = rows;
      if (!row) throw new Error('unreachable — row count asserted above');
      expect(row.tenantId).toBe(hospitalityTenantId);
    });

    test('AC #4 cross-tenant — same email at a second tenant succeeds (tenant isolation invariant)', async ({
      request,
    }) => {
      const email = `t+cross-${nonce()}@del3.local`;

      const first = await request.post(urlFor(PIZZA_BRAND_SLUG, '/api/auth/sign-up/email'), {
        data: { name: 'Pizza Cross', email, password: 'test-pass-12chars' },
        headers: { Origin: `http://${PIZZA_BRAND_SLUG}.localhost:${STOREFRONT_PORT}` },
      });
      expect(first.status(), 'first signup must succeed').toBe(200);

      const second = await request.post(urlFor(OTHER_BRAND_SLUG, '/api/auth/sign-up/email'), {
        data: { name: 'Other Cross', email, password: 'test-pass-12chars' },
        headers: { Origin: `http://${OTHER_BRAND_SLUG}.localhost:${STOREFRONT_PORT}` },
      });
      expect(second.status(), `cross-tenant signup body: ${await second.text()}`).toBe(200);

      const rows = await db
        .select({ id: tenantEndUsers.id, tenantId: tenantEndUsers.tenantId })
        .from(tenantEndUsers)
        .where(and(eq(tenantEndUsers.email, email), isNull(tenantEndUsers.deletedAt)));
      expect(rows.length, 'expected one row per tenant').toBe(2);
      const tenantIds = rows.map((r) => r.tenantId).sort();
      const expected = [hospitalityTenantId, otherTenantId].sort();
      expect(tenantIds).toEqual(expected);

      // Both rows have sessions stamped with the brand the signup happened on.
      const sessionBrandIds = (
        await db
          .select({
            tenantEndUserId: tenantEndUserSessions.tenantEndUserId,
            currentBrandId: tenantEndUserSessions.currentBrandId,
          })
          .from(tenantEndUserSessions)
      ).filter((s) => rows.some((r) => r.id === s.tenantEndUserId));
      expect(new Set(sessionBrandIds.map((s) => s.currentBrandId))).toEqual(
        new Set([pizzaBrandId, otherBrandId]),
      );
    });

    test('AC #5 negative — request with no resolvable brand returns 400 and writes no row', async ({
      request,
    }) => {
      const email = `t+nobrand-${nonce()}@del3.local`;
      const res = await request.post(`http://localhost:${STOREFRONT_PORT}/api/auth/sign-up/email`, {
        data: { name: 'No Brand', email, password: 'test-pass-12chars' },
        headers: { Origin: `http://localhost:${STOREFRONT_PORT}` },
      });
      expect(res.status()).toBeGreaterThanOrEqual(400);
      expect(res.status()).toBeLessThan(500);
      expect(await res.text()).toMatch(/no resolvable tenant/i);

      const rows = await db
        .select({ id: tenantEndUsers.id })
        .from(tenantEndUsers)
        .where(eq(tenantEndUsers.email, email));
      expect(rows.length, 'no row may be written when brand context missing').toBe(0);
    });

    // DEL-12: cross-tenant OAuth account isolation. Skipped until DEL-8 lands a
    // multi-tenant seed + a Google OAuth test-double. The unit-level coverage
    // for the adapter wrapper lives in packages/auth-core/src/storefront-adapter.test.ts
    // (10 cases). The Path A staging+prd smoke verifies the BA-config layer
    // end-to-end (signup → SELECT tenant_id). What this skipped E2E would add
    // when DEL-8 unblocks it: a real Google OAuth round-trip at two tenants
    // proving (provider_id, account_id, tenant_id) uniqueness at the HTTP layer.
    test.skip('DEL-12 cross-tenant OAuth — same Google account at two tenants creates two rows', async () => {
      // Pending DEL-8 multi-tenant seed + Google OAuth test-double.
      // Expected behavior post-impl:
      //   1. Sign in via Google at pizza-express → creates account A
      //      with (provider_id='google', account_id='<google-uid>', tenant_id=hospitality_group)
      //   2. Sign in via Google at burger-heaven-other-co (second tenant) with SAME Google account →
      //      creates account B with same provider_id/account_id but tenant_id=other_co.
      //      No 422/409. Two distinct rows in tenant_end_user_accounts.
      //   3. Sessions are independent; user A and user B have no relationship.
    });
  });
