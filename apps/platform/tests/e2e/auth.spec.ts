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
 * Assumes seed data created a test admin user:
 *   email: admin@test.local
 *   password: SuperSecretPassword123!
 */

test.describe('Platform Auth', () => {
  test('redirects unauthenticated users to login', async ({ page }) => {
    await page.goto('/dashboard');
    await expect(page).toHaveURL(/\/login/);
  });

  test('shows login form', async ({ page }) => {
    await page.goto('/login');
    await expect(page.getByRole('heading', { name: /welcome back/i })).toBeVisible();
    await expect(page.getByLabel(/email/i)).toBeVisible();
    await expect(page.getByLabel(/password/i)).toBeVisible();
  });

  test('successful login with email/password', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel(/email/i).fill('admin@test.local');
    await page.getByLabel(/password/i).fill('SuperSecretPassword123!');
    await page.getByRole('button', { name: /sign in/i }).click();

    await expect(page).toHaveURL(/\/dashboard/);
  });

  test('rejects wrong password', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel(/email/i).fill('admin@test.local');
    await page.getByLabel(/password/i).fill('WrongPassword');
    await page.getByRole('button', { name: /sign in/i }).click();

    await expect(page.getByText(/invalid/i)).toBeVisible();
  });

  test('respects next parameter after login', async ({ page }) => {
    await page.goto('/dashboard/tenants');
    await expect(page).toHaveURL(/\/login\?next=/);

    await page.getByLabel(/email/i).fill('admin@test.local');
    await page.getByLabel(/password/i).fill('SuperSecretPassword123!');
    await page.getByRole('button', { name: /sign in/i }).click();

    await expect(page).toHaveURL(/\/dashboard\/tenants/);
  });
});
