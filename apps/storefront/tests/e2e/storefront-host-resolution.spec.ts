import { expect, test } from '@playwright/test';
import { db } from '@rp/db';
import {
  storefronts,
  tenantEndUserSessions,
  tenantEndUserVerifications,
  tenantEndUsers,
  tenants,
} from '@rp/db/schema';
import { and, desc, eq, isNull } from 'drizzle-orm';

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

    // ── DEL-22 tenant-host auth flows ──────────────────────────────────────
    //
    // These three tests share a single test-scoped user (created in test 7's
    // signup, exercised by tests 8 and 9). They assert HTTP 200 + DB effects
    // only — Inngest event payload shape is covered by `@rp/emails` unit tests.
    // The OOMI Kitchen Test fixture from `beforeAll` is the storefront these
    // requests resolve to.

    const tenantUserEmail = `del22-tenant-${Date.now()}@smoke.local`;
    const tenantUserPassword = 'tenant-pass-12chars';
    const oomiOrigin = `http://${OOMI_STOREFRONT_SLUG}.localhost:${STOREFRONT_PORT}`;
    let tenantEndUserId: string;

    test('7. tenant-host password signup creates user + session with currentBrandId NULL (DEL-22)', async ({
      request,
    }) => {
      const res = await request.post(urlFor(OOMI_STOREFRONT_SLUG, '/api/auth/sign-up/email'), {
        data: { name: 'DEL-22 tenant smoke', email: tenantUserEmail, password: tenantUserPassword },
        headers: { Origin: oomiOrigin },
      });
      expect(res.status(), `tenant-host signup body: ${await res.text()}`).toBe(200);

      const [user] = await db
        .select({ id: tenantEndUsers.id, tenantId: tenantEndUsers.tenantId })
        .from(tenantEndUsers)
        .where(and(eq(tenantEndUsers.email, tenantUserEmail), isNull(tenantEndUsers.deletedAt)))
        .limit(1);
      if (!user) throw new Error(`user row not written for ${tenantUserEmail}`);
      expect(user.tenantId).toBe(oomiTenantId);
      tenantEndUserId = user.id;

      const [session] = await db
        .select({ currentBrandId: tenantEndUserSessions.currentBrandId })
        .from(tenantEndUserSessions)
        .where(eq(tenantEndUserSessions.tenantEndUserId, user.id))
        .orderBy(desc(tenantEndUserSessions.createdAt))
        .limit(1);
      if (!session) throw new Error('session row not written for tenant-host signup');
      // DEL-22 + DEL-21: tenant-host sessions stamp NULL.
      expect(session.currentBrandId).toBeNull();
    });

    test('8. tenant-host OTP request writes verification row with brandId NULL (DEL-22)', async ({
      request,
    }) => {
      if (!tenantEndUserId) {
        throw new Error('test 7 must run before test 8 — describe.serial is required');
      }
      const res = await request.post(
        urlFor(OOMI_STOREFRONT_SLUG, '/api/auth/email-otp/send-verification-otp'),
        {
          data: { email: tenantUserEmail, type: 'sign-in' },
          headers: { Origin: oomiOrigin },
        },
      );
      expect(res.status(), `tenant-host OTP body: ${await res.text()}`).toBe(200);

      const [verification] = await db
        .select({
          tenantId: tenantEndUserVerifications.tenantId,
          brandId: tenantEndUserVerifications.brandId,
        })
        .from(tenantEndUserVerifications)
        .where(eq(tenantEndUserVerifications.identifier, `sign-in-otp-${tenantUserEmail}`))
        .orderBy(desc(tenantEndUserVerifications.createdAt))
        .limit(1);
      if (!verification) throw new Error('verification row not written for tenant-host OTP');
      expect(verification.tenantId).toBe(oomiTenantId);
      // DEL-22 adapter `ctx.brandId ?? null` — tenant-host verifications stamp NULL.
      expect(verification.brandId).toBeNull();
    });

    test('9. tenant-host password reset request returns 200 for existing user (DEL-22)', async ({
      request,
    }) => {
      if (!tenantEndUserId) {
        throw new Error('test 7 must run before test 9 — describe.serial is required');
      }
      // BA 1.6.x exposes the sendResetPassword callback via `/request-password-reset`
      // (verified at node_modules/better-auth/.../api/routes/password.mjs:20).
      const res = await request.post(urlFor(OOMI_STOREFRONT_SLUG, '/api/auth/request-password-reset'), {
        data: {
          email: tenantUserEmail,
          redirectTo: `${oomiOrigin}/reset-password`,
        },
        headers: { Origin: oomiOrigin },
      });
      expect(res.status(), `tenant-host password-reset body: ${await res.text()}`).toBe(200);
      // The Inngest event payload (mode: 'tenant', storefrontId/storefrontSlug)
      // and the URL rewrite to oomi-kitchen-test.* are covered by @rp/emails
      // unit tests. This e2e asserts the callback executes without throwing
      // — i.e., the resolver doesn't 400 on absent brandId (AC#4).
    });
  });
