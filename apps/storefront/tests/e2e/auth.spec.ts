import { expect, test } from '@playwright/test';
import { db } from '@rp/db';
import { tenantEndUsers } from '@rp/db/schema';
import { and, eq, isNull } from 'drizzle-orm';

import { pollInngestDevForPasswordReset } from './helpers/inngest';

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

test.describe('next-param propagation through forgot/reset (Phase 3 Step 2)', () => {
  // Edge case: a `next` that itself contains `?` and `&`. Naive
  // `&next=…` template appending breaks; URLSearchParams composition
  // handles it correctly. Phase 3 Step 2 spec AC #4.
  const nextWithQuery = '/checkout?ref=x&utm=y';
  const encodedNext = encodeURIComponent(nextWithQuery);

  // Track ephemeral users for cleanup.
  const userIds: string[] = [];

  test.afterAll(async () => {
    for (const id of userIds) {
      await db.delete(tenantEndUsers).where(eq(tenantEndUsers.id, id));
    }
  });

  test('login.tsx propagates next to the forgot-password link via URLSearchParams', async ({
    page,
  }) => {
    // Visit /login with an edge-case `next` and switch to password mode
    // (the forgot-password link is only rendered in password mode).
    await page.goto(`/login?next=${encodedNext}`);
    await page.getByRole('button', { name: /sign in with password/i }).click();

    // The "Forgot your password?" link should propagate `next` in its
    // href via URLSearchParams composition. We assert on the substring
    // because the link can include other params in any order.
    const forgotLink = page.getByRole('link', { name: /forgot your password/i });
    await expect(forgotLink).toBeVisible();
    const href = await forgotLink.getAttribute('href');
    expect(href, 'forgot link should include next-param').toContain(
      `next=${encodedNext}`,
    );
  });

  test('forgot-password form submits with redirectTo carrying next; Inngest event URL includes the encoded next in callbackURL', async ({
    page,
    request,
  }) => {
    // BA's request-password-reset is enumeration-safe — same success
    // copy for both existing + non-existing emails, but the Inngest
    // event is ONLY emitted when the user exists (BA's standard
    // existence-check short-circuit). For the Inngest assertion to
    // fire, we must first create a real user via HTTP signup.
    const email = `step2-forgot-${Date.now()}@step2.test`;
    const signup = await request.post(
      'http://pizza-express.localhost:3001/api/auth/sign-up/email',
      {
        data: { email, password: 'step2-pass-12chars', name: 'Step 2 Test' },
        headers: { Origin: 'http://pizza-express.localhost:3001' },
      },
    );
    expect(signup.status(), `signup body: ${await signup.text()}`).toBe(200);

    // Capture the inserted user id for afterAll cleanup.
    const [user] = await db
      .select({ id: tenantEndUsers.id })
      .from(tenantEndUsers)
      .where(
        and(eq(tenantEndUsers.email, email), isNull(tenantEndUsers.deletedAt)),
      )
      .limit(1);
    if (!user) throw new Error(`user row not written for ${email}`);
    userIds.push(user.id);

    // Navigate to /forgot-password?next=… (the form reads `next` from
    // useSearchParams). Use the SAME email we just signed up.
    await page.goto(`/forgot-password?next=${encodedNext}`);
    await page.getByLabel(/email/i).fill(email);
    await page.getByRole('button', { name: /send reset link/i }).click();
    await expect(page.getByText(/check your email/i)).toBeVisible();

    // BA emits `email.password_reset.requested` via Inngest. The event's
    // `data.url` is the storefront-rewritten reset link (DEL-15) and
    // has shape `<base>/reset-password/<token>?callbackURL=<encoded-redirectTo>`.
    // We assert the callbackURL query param carries the next-param,
    // proving the forgot form composed redirectTo correctly.
    const poll = await pollInngestDevForPasswordReset(email, 30_000);
    if (poll.status === 'unreachable') {
      test.skip(
        true,
        'Inngest dev (:8288) not running — see AGENTS.md Gotchas. Start `inngest-cli dev` to run this assertion.',
      );
      return;
    }
    if (poll.status === 'timeout') {
      throw new Error(
        `password_reset event not found in Inngest dev within 30s. email=${email}`,
      );
    }

    // Parse the BA-composed URL and assert callbackURL carries the
    // next param exactly as we composed it.
    const eventUrl = new URL(poll.url);
    const callbackURL = eventUrl.searchParams.get('callbackURL');
    expect(callbackURL, 'BA URL should carry our redirectTo as callbackURL').not.toBeNull();
    // `callbackURL` is the un-decoded /reset-password URL (e.g.,
    // "/reset-password?next=/checkout?ref=x&utm=y"). Parsing it as a
    // URL is awkward because it's a relative path; just assert the
    // next-param round-trips.
    expect(callbackURL).toContain('next=');
    expect(callbackURL).toContain(encodeURIComponent(nextWithQuery));
  });

  test('reset-password form renders with token + next', async ({ page }) => {
    // We can't easily exercise the BA reset-password POST without a
    // real token. Instead assert the DOM/URL chain: the form mounts
    // with `next` in URL when both `token` and `next` query params are
    // present, proving the token-required guard doesn't short-circuit.
    await page.goto(
      `/reset-password?token=fake-token-step2&next=${encodedNext}`,
    );

    // CardTitle from @rp/ui renders as <div>, not a heading element
    // (precedent: this same fact is noted at the top of auth.spec.ts
    // for the LoginForm rendering check). So we match on text rather
    // than role=heading.
    await expect(page.getByText('Reset your password').first()).toBeVisible();
    await expect(page.getByLabel(/new password/i)).toBeVisible();
    await expect(page.getByLabel(/confirm password/i)).toBeVisible();

    // The success-redirect URL composition is a pure function of the
    // URL search params. Verifying the success path with an actual
    // token-submit would require a real BA reset (signup + forgot +
    // poll for token + reset). That's heavier than the unit-level
    // invariant being tested; for E2E we trust the form's
    // URLSearchParams composition (verified by code review +
    // typecheck) with this test asserting the form mounts cleanly
    // when BOTH token and next are present in URL.
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
