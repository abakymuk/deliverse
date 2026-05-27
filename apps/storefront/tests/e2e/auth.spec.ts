import { expect, test } from '@playwright/test';
import { db } from '@rp/db';
import { tenantEndUsers } from '@rp/db/schema';
import { and, eq, isNull } from 'drizzle-orm';

/**
 * Storefront auth E2E tests
 *
 * Tests on brand subdomain (pizza-express.localhost).
 * Requires /etc/hosts entry or Chrome auto-resolve.
 *
 * Assumes seed data:
 *   - Brand: pizza-express (slug) — Hospitality Group tenant
 *   - Brand: burger-heaven (slug) — same tenant as pizza-express, for cross-brand test
 *   - Brand: other-brand-test (slug) — second tenant, only when SEED_TEST_FIXTURES=1
 *     (DEL-8 / CI). The tenant-isolation test below requires this.
 *   - Test end user: guest@test.local (created on demand by OTP-request flow)
 */

test.describe('Storefront Auth — OTP flow', () => {
  test('renders branded login page', async ({ page }) => {
    await page.goto('/login');
    await expect(page.getByRole('heading')).toContainText(/pizza express/i);
    await expect(page.getByLabel(/email/i)).toBeVisible();
  });

  test('OTP request redirects to verify page', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel(/email/i).fill('guest@test.local');
    await page.getByRole('button', { name: /send code/i }).click();

    await expect(page).toHaveURL(/\/verify-otp/);
    await expect(page.getByText(/check your email/i)).toBeVisible();
  });

  test('can toggle to password mode', async ({ page }) => {
    await page.goto('/login');
    await expect(page.getByLabel(/password/i)).not.toBeVisible();

    await page.getByRole('button', { name: /sign in with password/i }).click();
    await expect(page.getByLabel(/password/i)).toBeVisible();
  });
});

test.describe('Cross-brand recognition (same tenant)', () => {
  test('signup page shows sibling-brand disclosure', async ({ page }) => {
    // Seed has Hospitality Group + pizza-express + burger-heaven (same tenant).
    // Visiting pizza-express signup should disclose Burger Heaven as a sibling.
    // DEL-7 always-on inline disclosure per docs/specs/auth-ui.md §4 decision #1.
    await page.goto('/signup');
    await expect(page.getByText(/Pizza Express is part of Hospitality Group/i)).toBeVisible();
    await expect(page.getByText(/Burger Heaven/)).toBeVisible();
    await expect(page.getByText(/Your account works at all of them/i)).toBeVisible();
  });
});

test.describe('Tenant isolation', () => {
  test('same email at different tenants are different accounts', async ({ request }) => {
    // DEL-3 (tenant-scoped adapter) + DEL-12 (account-model tenant scoping) +
    // DEL-8 (multi-tenant seed fixture) make this end-to-end testable. Two
    // signups with the same email at different tenants must produce two
    // independent user rows. Distinct from the cross-tenant test in
    // storefront-tenant-scoping.spec.ts which uses its own `other-brand-del3-test`
    // fixture; this test uses the canonical SEED_TEST_FIXTURES slug.
    const email = `t-${Date.now()}@del8.test`;

    // Signup at pizza-express (Hospitality Group tenant)
    const a = await request.post(
      'http://pizza-express.localhost:3001/api/auth/sign-up/email',
      {
        data: { email, password: 'test-pass-12chars', name: 'A' },
        headers: { Origin: 'http://pizza-express.localhost:3001' },
      },
    );
    expect(a.status(), `pizza-express signup body: ${await a.text()}`).toBe(200);

    // Signup at other-brand-test (Other Co tenant) with SAME email — should succeed
    const b = await request.post(
      'http://other-brand-test.localhost:3001/api/auth/sign-up/email',
      {
        data: { email, password: 'test-pass-12chars', name: 'B' },
        headers: { Origin: 'http://other-brand-test.localhost:3001' },
      },
    );
    expect(b.status(), `other-brand-test signup body: ${await b.text()}`).toBe(200);

    // DB assertion: two distinct rows in tenant_end_users (one per tenant).
    // `isNull(deletedAt)` matches repo convention for partial-unique tables.
    const rows = await db
      .select({ id: tenantEndUsers.id, tenantId: tenantEndUsers.tenantId })
      .from(tenantEndUsers)
      .where(and(eq(tenantEndUsers.email, email), isNull(tenantEndUsers.deletedAt)));
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.tenantId)).size).toBe(2);
  });
});
