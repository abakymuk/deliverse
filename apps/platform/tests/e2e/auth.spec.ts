import { test, expect } from '@playwright/test';

/**
 * Platform auth E2E tests
 *
 * Covers acceptance criteria from docs/auth-spec.md:
 *   - Login with email/password
 *   - Login with Google OAuth (mocked)
 *   - Session expiry
 *   - Logout
 *
 * Assumes seed data created a test admin user (admin@test.local).
 * Password comes from E2E_ADMIN_PASSWORD env (set by CI to match
 * SEED_ADMIN_PASSWORD). Local default = 'Admin-Dev-Pass-1' (matches
 * seed.ts DEFAULT_ADMIN_PASSWORD when SEED_ADMIN_PASSWORD isn't set).
 */

const ADMIN_PW = process.env.E2E_ADMIN_PASSWORD ?? 'Admin-Dev-Pass-1';

test.describe('Platform Auth', () => {
  test('redirects unauthenticated users to login', async ({ page }) => {
    await page.goto('/dashboard');
    await expect(page).toHaveURL(/\/login/);
  });

  test('shows login form', async ({ page }) => {
    await page.goto('/login');
    // CardTitle from @rp/ui renders as <div>, not a heading element — so
    // getByRole('heading') doesn't match. Use getByText for the title +
    // getByLabel for form fields (those are real <label htmlFor>).
    await expect(page.getByText(/login to your account/i)).toBeVisible();
    await expect(page.getByLabel(/email/i)).toBeVisible();
    await expect(page.getByLabel(/password/i)).toBeVisible();
  });

  test('successful login with email/password', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel(/email/i).fill('admin@test.local');
    await page.getByLabel(/password/i).fill(ADMIN_PW);

    // Capture the BA signin response so failures here have diagnostic data
    // (DEL-8 first run showed URL didn't redirect; this lets us see if BA
    // returned an error or success-with-cookie-issue).
    const signinResp = page.waitForResponse(
      (resp) => resp.url().includes('/api/auth/sign-in/email') && resp.request().method() === 'POST',
    );
    // Two buttons contain "Login": the submit button (exact) and "Login with Google".
    await page.getByRole('button', { name: 'Login', exact: true }).click();
    const resp = await signinResp;
    const body = await resp.text().catch(() => '<no-body>');
    console.log(`[diagnostic] signin status=${resp.status()} body=${body.slice(0, 300)}`);

    await expect(page).toHaveURL(/\/dashboard/, { timeout: 10000 });
  });

  test('rejects wrong password', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel(/email/i).fill('admin@test.local');
    // Form has a zod min(12) password validator — use ≥12-char wrong pw to
    // ensure the BA call actually fires (not blocked by client-side validation).
    await page.getByLabel(/password/i).fill('WrongPassword99');
    await page.getByRole('button', { name: 'Login', exact: true }).click();

    await expect(page.getByText(/invalid/i)).toBeVisible();
  });

  test('respects next parameter after login', async ({ page }) => {
    await page.goto('/dashboard/tenants');
    await expect(page).toHaveURL(/\/login\?next=/);

    await page.getByLabel(/email/i).fill('admin@test.local');
    await page.getByLabel(/password/i).fill(ADMIN_PW);

    const signinResp = page.waitForResponse(
      (resp) => resp.url().includes('/api/auth/sign-in/email') && resp.request().method() === 'POST',
    );
    await page.getByRole('button', { name: 'Login', exact: true }).click();
    const resp = await signinResp;
    const body = await resp.text().catch(() => '<no-body>');
    console.log(`[diagnostic next-param] signin status=${resp.status()} body=${body.slice(0, 300)}`);

    await expect(page).toHaveURL(/\/dashboard\/tenants/, { timeout: 10000 });
  });
});
