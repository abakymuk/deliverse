import { expect, test } from '@playwright/test';
import { db } from '@rp/db';
import {
  brands,
  storefronts,
  tenantEndUserAccounts,
  tenantEndUserSessions,
  tenantEndUsers,
  tenants,
} from '@rp/db/schema';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { signInWithFakeGoogle } from './helpers/oauth-double';

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

      // DEL-22: post-resolver-flip, the BA tenant context resolves through
      // `storefronts` (not `brands`). The test brand needs a matching
      // type='brand' storefront row or the resolver will 400 with
      // "storefront not found or inactive".
      await db
        .insert(storefronts)
        .values({
          tenantId: otherTenantId,
          slug: OTHER_BRAND_SLUG,
          name: 'Other Brand (DEL-3 test)',
          type: 'brand',
          primaryBrandId: otherBrandId,
          brandingJson: {},
          isActive: true,
        })
        .onConflictDoNothing();
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

    // DEL-12: cross-tenant OAuth account isolation. Unskipped 2026-05-27
    // (Phase 3 M2 / Step 5) via `BA_OAUTH_TEST_MODE=1` + BA hook
    // overrides — see helpers/oauth-double.ts header for the design
    // rationale and packages/auth-core/src/storefront-oauth-test-mode.ts
    // for the BA-source verification.
    //
    // The same fake Google uid is presented to BA at two distinct tenants
    // (Hospitality Group via pizza-express; Other Co via other-brand-del3-test
    // — both fixtures already seeded by this spec's beforeAll). DEL-12's
    // schema delta (`tenant_id` on `tenant_end_user_accounts` + tenant-
    // scoped unique `(tenant_id, provider_id, account_id)`) is what
    // permits two rows to coexist for the same `(provider_id, account_id)`
    // pair when their `tenant_id` differs. Pre-DEL-12 this would have
    // 422'd on the second signup; post-DEL-12 it must succeed.
    test('DEL-12 cross-tenant OAuth — same Google account at two tenants creates two rows', async ({
      request,
    }) => {
      // Skip cleanly if BA_OAUTH_TEST_MODE wasn't set on the dev server —
      // the fake idToken would fail BA's default verifyIdToken (real
      // Google JWT verification) with 401, and the failure mode would
      // look like a regression in this test rather than missing config.
      // CI sets the flag for the storefront e2e job; local dev needs
      // `BA_OAUTH_TEST_MODE=1 doppler run --config dev -- pnpm dev` in
      // apps/storefront to exercise this.
      test.skip(
        process.env.BA_OAUTH_TEST_MODE !== '1',
        'DEL-12 OAuth e2e requires BA_OAUTH_TEST_MODE=1 on the dev server (CI only by default — see helpers/oauth-double.ts)',
      );

      const fakeUid = `google-uid-cross-tenant-${nonce()}`;
      const email = `t+oauth-cross-${nonce()}@del12.local`;

      // Signin #1 — pizza-express (Hospitality Group tenant).
      const firstSignIn = await signInWithFakeGoogle(request, PIZZA_BRAND_SLUG, {
        uid: fakeUid,
        email,
        name: 'OAuth Cross-Tenant Test',
      });

      const firstAccounts = await db
        .select({
          id: tenantEndUserAccounts.id,
          providerId: tenantEndUserAccounts.providerId,
          accountId: tenantEndUserAccounts.accountId,
          tenantId: tenantEndUserAccounts.tenantId,
          tenantEndUserId: tenantEndUserAccounts.tenantEndUserId,
        })
        .from(tenantEndUserAccounts)
        .where(
          and(
            eq(tenantEndUserAccounts.providerId, 'google'),
            eq(tenantEndUserAccounts.accountId, fakeUid),
          ),
        );

      expect(
        firstAccounts.length,
        'first signin must create exactly one google account row',
      ).toBe(1);
      const [firstAccount] = firstAccounts;
      if (!firstAccount) throw new Error('unreachable');
      expect(firstAccount.tenantId).toBe(hospitalityTenantId);
      expect(firstAccount.tenantEndUserId).toBe(firstSignIn.userId);

      // Signin #2 — other-brand-del3-test (Other Co tenant). SAME fakeUid +
      // SAME email — the DEL-12 invariant says this must succeed (tenant-
      // scoped unique on accounts; tenant-scoped users — DEL-3).
      const secondSignIn = await signInWithFakeGoogle(
        request,
        OTHER_BRAND_SLUG,
        { uid: fakeUid, email, name: 'OAuth Cross-Tenant Test' },
      );

      // The second signin MUST create an independent user + account row
      // — same email is allowed across tenants because end users are
      // tenant-scoped per ADR-0003.
      expect(
        secondSignIn.userId,
        'second signin must create a distinct user row (cross-tenant invariant)',
      ).not.toBe(firstSignIn.userId);

      const allAccounts = await db
        .select({
          id: tenantEndUserAccounts.id,
          providerId: tenantEndUserAccounts.providerId,
          accountId: tenantEndUserAccounts.accountId,
          tenantId: tenantEndUserAccounts.tenantId,
          tenantEndUserId: tenantEndUserAccounts.tenantEndUserId,
        })
        .from(tenantEndUserAccounts)
        .where(
          and(
            eq(tenantEndUserAccounts.providerId, 'google'),
            eq(tenantEndUserAccounts.accountId, fakeUid),
          ),
        );

      expect(
        allAccounts.length,
        'after two signins: exactly two account rows with same (provider_id, account_id) but different tenant_id',
      ).toBe(2);

      const tenantIds = allAccounts.map((a) => a.tenantId).sort();
      const expected = [hospitalityTenantId, otherTenantId].sort();
      expect(tenantIds).toEqual(expected);

      // Each account row points at the user row in its own tenant.
      const userIdsByTenant = new Map(
        allAccounts.map((a) => [a.tenantId, a.tenantEndUserId]),
      );
      expect(userIdsByTenant.get(hospitalityTenantId)).toBe(firstSignIn.userId);
      expect(userIdsByTenant.get(otherTenantId)).toBe(secondSignIn.userId);

      // Sessions are independent — confirm both signins have their own
      // session rows (cookieCache writes a row at signin time per BA
      // contract — `dist/api/routes/sign-in.mjs:121` `setSessionCookie`
      // → `setSessionCookie` calls `internalAdapter.createSession`).
      const sessions = await db
        .select({
          id: tenantEndUserSessions.id,
          tenantEndUserId: tenantEndUserSessions.tenantEndUserId,
          tenantId: tenantEndUserSessions.tenantId,
        })
        .from(tenantEndUserSessions)
        .where(
          inArray(tenantEndUserSessions.tenantEndUserId, [
            firstSignIn.userId,
            secondSignIn.userId,
          ]),
        );

      expect(
        sessions.length,
        'each signin must produce its own session row',
      ).toBeGreaterThanOrEqual(2);
      // Hospitality Group user's session has Hospitality Group's tenant_id;
      // Other Co user's session has Other Co's tenant_id. The post-DEL-26 +
      // cookie-cache-tenant-version closure (session-model-scoped) guarantees
      // the session row carries the tenant boundary.
      const tenantIdsFromSessions = sessions.map((s) => s.tenantId).sort();
      expect(new Set(tenantIdsFromSessions)).toEqual(
        new Set([hospitalityTenantId, otherTenantId]),
      );

      // Cleanup: delete the two ephemeral users (cascades to accounts +
      // sessions via FK ON DELETE CASCADE).
      await db
        .delete(tenantEndUsers)
        .where(
          inArray(tenantEndUsers.id, [firstSignIn.userId, secondSignIn.userId]),
        );
    });
  });
