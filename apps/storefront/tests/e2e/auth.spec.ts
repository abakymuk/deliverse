import { test, expect } from '@playwright/test';

/**
 * Storefront auth E2E tests
 *
 * Tests on brand subdomain (pizza-express.localhost).
 * Requires /etc/hosts entry or Chrome auto-resolve.
 *
 * Assumes seed data:
 *   - Brand: pizza-express (slug)
 *   - Brand: burger-heaven (slug, same tenant as pizza-express for cross-brand test)
 *   - Test end user: guest@test.local
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
  test('disclosure shown on sibling brand', async () => {
    // User signs up at pizza-express
    // Visits burger-heaven (same tenant)
    // Should see disclosure that account works across brands
    // TODO: implement after seed data is ready
    test.skip();
  });
});

test.describe('Tenant isolation', () => {
  test('same email at different tenants are different accounts', async () => {
    // John signs up at tenant A's pizza-express
    // John signs up at tenant B's other-brand with same email
    // Should be two separate accounts
    // TODO: implement after we have multi-tenant test data
    test.skip();
  });
});
