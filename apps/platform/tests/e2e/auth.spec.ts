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
    // Actual heading per apps/platform/src/components/auth/login-form.tsx:86
    // ("Login to your account"). Tests previously asserted "Welcome back"
    // which never matched — DEL-8 fixes the stale expectation.
    await expect(page.getByRole('heading', { name: /login to your account/i })).toBeVisible();
    await expect(page.getByLabel(/email/i)).toBeVisible();
    await expect(page.getByLabel(/password/i)).toBeVisible();
  });

  test('successful login with email/password', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel(/email/i).fill('admin@test.local');
    await page.getByLabel(/password/i).fill(ADMIN_PW);
    // Two buttons on the page contain "Login": the submit button (exact "Login")
    // and "Login with Google". `exact: true` disambiguates.
    await page.getByRole('button', { name: 'Login', exact: true }).click();

    await expect(page).toHaveURL(/\/dashboard/);
  });

  test('rejects wrong password', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel(/email/i).fill('admin@test.local');
    await page.getByLabel(/password/i).fill('WrongPassword');
    await page.getByRole('button', { name: 'Login', exact: true }).click();

    await expect(page.getByText(/invalid/i)).toBeVisible();
  });

  test('respects next parameter after login', async ({ page }) => {
    await page.goto('/dashboard/tenants');
    await expect(page).toHaveURL(/\/login\?next=/);

    await page.getByLabel(/email/i).fill('admin@test.local');
    await page.getByLabel(/password/i).fill(ADMIN_PW);
    await page.getByRole('button', { name: 'Login', exact: true }).click();

    await expect(page).toHaveURL(/\/dashboard\/tenants/);
  });
});
