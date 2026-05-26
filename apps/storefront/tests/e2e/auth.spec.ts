import { expect, test } from '@playwright/test';

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
  test('same email at different tenants are different accounts', async () => {
    // John signs up at tenant A's pizza-express
    // John signs up at tenant B's other-brand with same email
    // Should be two separate accounts
    // TODO: implement after we have multi-tenant test data
    test.skip();
  });
});
