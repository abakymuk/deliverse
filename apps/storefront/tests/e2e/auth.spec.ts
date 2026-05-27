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
  test('renders login page', async ({ page }) => {
    // The current LoginForm renders a generic "Sign in" CardTitle — no brand
    // banner. Brand-themed page header is a future enhancement; for DEL-8 we
    // verify the form renders + the email field is present. If/when a brand
    // banner lands, switch this to assert `/pizza express/i` in the title.
    // CardTitle from @rp/ui renders as <div>, not a heading element, so
    // getByText is the right matcher (not getByRole('heading')).
    await page.goto('/login');
    await expect(page.getByText(/sign in/i).first()).toBeVisible();
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

  test('verify-otp shows welcome-back when crossing brands (DEL-14)', async ({ page, request }) => {
    // Signup at pizza-express (creates the tenant_end_users row + a session at
    // pizza-express via autoSignIn). Then visit burger-heaven /login with the
    // SAME email — the verify-otp page should server-side detect that:
    //   - the email exists in this tenant (Hospitality Group)
    //   - the user has no prior session at burger-heaven (crossed brands)
    // and render the welcome-back copy per docs/specs/auth-ui.md §5e DEL-14.
    const email = `del14-${Date.now()}@del14.test`;

    const signup = await request.post(
      'http://pizza-express.localhost:3001/api/auth/sign-up/email',
      {
        data: { email, password: 'test-pass-12chars', name: 'DEL-14 Test' },
        headers: { Origin: 'http://pizza-express.localhost:3001' },
      },
    );
    expect(signup.status(), `signup body: ${await signup.text()}`).toBe(200);

    // Cross-brand visit: enter the same email at burger-heaven's OTP login.
    await page.goto('http://burger-heaven.localhost:3001/login');
    await page.getByLabel(/email/i).fill(email);
    await page.getByRole('button', { name: /send code/i }).click();

    await expect(page).toHaveURL(/burger-heaven.*\/verify-otp/);
    await expect(page.getByText(/welcome back/i)).toBeVisible();
    await expect(page.getByText(/Burger Heaven is part of Hospitality Group/i)).toBeVisible();
    await expect(page.getByText(/your account works here too/i)).toBeVisible();
  });

  test('verify-otp shows default copy when same brand as signup (DEL-14)', async ({
    page,
    request,
  }) => {
    // Negative case: signup at pizza-express, then OTP login at pizza-express
    // (same brand). The hasUserVisitedBrand check returns true (the signup's
    // autoSignIn session is at pizza-express), so welcome-back must NOT fire.
    const email = `del14-same-${Date.now()}@del14.test`;

    const signup = await request.post(
      'http://pizza-express.localhost:3001/api/auth/sign-up/email',
      {
        data: { email, password: 'test-pass-12chars', name: 'DEL-14 Same' },
        headers: { Origin: 'http://pizza-express.localhost:3001' },
      },
    );
    expect(signup.status(), `signup body: ${await signup.text()}`).toBe(200);

    await page.goto('/login'); // pizza-express baseURL
    await page.getByLabel(/email/i).fill(email);
    await page.getByRole('button', { name: /send code/i }).click();

    await expect(page).toHaveURL(/pizza-express.*\/verify-otp/);
    await expect(page.getByText(/check your email/i)).toBeVisible();
    await expect(page.getByText(/welcome back/i)).not.toBeVisible();
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
    const a = await request.post('http://pizza-express.localhost:3001/api/auth/sign-up/email', {
      data: { email, password: 'test-pass-12chars', name: 'A' },
      headers: { Origin: 'http://pizza-express.localhost:3001' },
    });
    expect(a.status(), `pizza-express signup body: ${await a.text()}`).toBe(200);

    // Signup at other-brand-test (Other Co tenant) with SAME email — should succeed
    const b = await request.post('http://other-brand-test.localhost:3001/api/auth/sign-up/email', {
      data: { email, password: 'test-pass-12chars', name: 'B' },
      headers: { Origin: 'http://other-brand-test.localhost:3001' },
    });
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
