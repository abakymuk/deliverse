import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: 'html',
  use: {
    baseURL: 'http://pizza-express.localhost:3001',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'pnpm dev',
    // BA's session endpoint returns 200 with body `null` when no session is
    // active — a real readiness signal. The bare `/` route returns 404
    // because the storefront proxy requires a brand subdomain, and 404 isn't
    // accepted by Playwright's webServer probe.
    url: 'http://localhost:3001/api/auth/get-session',
    reuseExistingServer: !process.env.CI,
    timeout: 240 * 1000,
  },
});
