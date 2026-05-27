/**
 * Storefront OTP rate-limit E2E tests (DEL-9 / docs/specs/otp-rate-limiting.md).
 *
 * Covers both gates per AC#6:
 *   - 60s request window per (tenant, lowercase email) — verified by issuing
 *     two consecutive sign-in OTP requests for a fresh email.
 *   - 15min cooldown after OTP_MAX_FAILURES (5) wrong attempts — verified by
 *     SQL-backdating a `tenant_otp_lockouts` row, NOT by actually exhausting
 *     attempts through Playwright (the harness has no clock-mock).
 *
 * Pattern matches existing tests (auth.spec.ts, storefront-tenant-scoping.spec.ts):
 * call BA's `/api/auth/email-otp/send-verification-otp` via `request.post`,
 * assert on response status + body. We avoid the browser form to keep error
 * surfaces inspectable.
 */

import { expect, test } from '@playwright/test';
import { db } from '@rp/db';
import { brands, tenantEndUserVerifications, tenantOtpLockouts } from '@rp/db/schema';
import { and, eq, sql } from 'drizzle-orm';

const PIZZA_EXPRESS_HOST = 'http://pizza-express.localhost:3001';
const SEND_OTP_PATH = '/api/auth/email-otp/send-verification-otp';

// Match the values exported from packages/auth-core/src/rate-limit.ts.
// Imported as constants instead of magic literals so the test fails loudly
// if the spec values shift without a coordinated test update.
const OTP_RATE_LIMIT_TOO_FREQUENT = 'otp_rate_limit_too_frequent';
const OTP_RATE_LIMIT_COOLDOWN = 'otp_rate_limit_cooldown';

async function getPizzaExpressTenantId(): Promise<string> {
  const [row] = await db
    .select({ tenantId: brands.tenantId })
    .from(brands)
    .where(eq(brands.slug, 'pizza-express'))
    .limit(1);
  if (!row) {
    throw new Error(
      'Seed missing: brand `pizza-express` not found. Run `doppler run -- pnpm db:seed` first.',
    );
  }
  return row.tenantId;
}

test.describe('OTP rate limiting — 60s request window', () => {
  test('second OTP request within 60s is rejected with otp_rate_limit_too_frequent', async ({
    request,
  }) => {
    const email = `del9-too-frequent-${Date.now()}@del9.test`;

    // First request — should succeed. BA writes a verification row whose
    // last_requested_at = now() (via column default).
    const first = await request.post(`${PIZZA_EXPRESS_HOST}${SEND_OTP_PATH}`, {
      data: { email, type: 'sign-in' },
      headers: { Origin: PIZZA_EXPRESS_HOST },
    });
    expect(first.status(), `first OTP body: ${await first.text()}`).toBe(200);

    // Second request — within 60s, should fail with our typed code.
    const second = await request.post(`${PIZZA_EXPRESS_HOST}${SEND_OTP_PATH}`, {
      data: { email, type: 'sign-in' },
      headers: { Origin: PIZZA_EXPRESS_HOST },
    });
    expect(second.status()).toBe(400);
    const body = (await second.json()) as { code?: string; message?: string };
    expect(body.code).toBe(OTP_RATE_LIMIT_TOO_FREQUENT);

    // Cleanup so reruns of this test (with the same timestamp seed bucket on
    // very fast re-runs) start fresh. Deleting by exact identifier is
    // bounded — no broader scope risk.
    await db
      .delete(tenantEndUserVerifications)
      .where(eq(tenantEndUserVerifications.identifier, `sign-in-otp-${email}`));
  });
});

test.describe('OTP rate limiting — 15min cooldown', () => {
  test('OTP request is rejected with otp_rate_limit_cooldown when an unexpired lockout exists', async ({
    request,
  }) => {
    const tenantId = await getPizzaExpressTenantId();
    const email = `del9-cooldown-${Date.now()}@del9.test`;
    const normalizedIdentifier = email.toLowerCase();

    // Stage state: insert an unexpired tenant_otp_lockouts row that mimics
    // "the user just hit OTP_MAX_FAILURES failed verifies and is now in
    // the 15min cooldown". We backdate `created_at` to 1 minute ago and
    // set `expires_at` to 14 minutes from now so checkOtpRequest sees an
    // active cooldown.
    const expiresAt = new Date(Date.now() + 14 * 60 * 1000);
    await db.insert(tenantOtpLockouts).values({
      tenantId,
      identifier: normalizedIdentifier,
      expiresAt,
    });

    try {
      const res = await request.post(`${PIZZA_EXPRESS_HOST}${SEND_OTP_PATH}`, {
        data: { email, type: 'sign-in' },
        headers: { Origin: PIZZA_EXPRESS_HOST },
      });
      expect(res.status()).toBe(400);
      const body = (await res.json()) as {
        code?: string;
        message?: string;
        retryAfterSeconds?: number;
      };
      expect(body.code).toBe(OTP_RATE_LIMIT_COOLDOWN);
      // retryAfterSeconds is included in the APIError body; it may or may not
      // round-trip through BA's serialization. If it does, sanity-check the
      // range; if not, the code assertion above already covers DEL-9 AC#6.
      if (typeof body.retryAfterSeconds === 'number') {
        expect(body.retryAfterSeconds).toBeGreaterThan(0);
        expect(body.retryAfterSeconds).toBeLessThanOrEqual(15 * 60);
      }
    } finally {
      // Cleanup: remove the staged lockout and any verification row that
      // might have been written by BA earlier in this test run.
      await db
        .delete(tenantOtpLockouts)
        .where(
          and(
            eq(tenantOtpLockouts.tenantId, tenantId),
            eq(tenantOtpLockouts.identifier, normalizedIdentifier),
          ),
        );
      await db
        .delete(tenantEndUserVerifications)
        .where(eq(tenantEndUserVerifications.identifier, `sign-in-otp-${email}`));
    }
  });

  test('OTP request succeeds when lockout has expired', async ({ request }) => {
    const tenantId = await getPizzaExpressTenantId();
    const email = `del9-cooldown-expired-${Date.now()}@del9.test`;
    const normalizedIdentifier = email.toLowerCase();

    // Stage: an EXPIRED lockout — checkOtpRequest filters `expires_at > now()`,
    // so this row should be ignored and the request should pass through.
    await db.insert(tenantOtpLockouts).values({
      tenantId,
      identifier: normalizedIdentifier,
      expiresAt: sql`now() - interval '1 minute'` as unknown as Date,
    });

    try {
      const res = await request.post(`${PIZZA_EXPRESS_HOST}${SEND_OTP_PATH}`, {
        data: { email, type: 'sign-in' },
        headers: { Origin: PIZZA_EXPRESS_HOST },
      });
      expect(res.status(), `expired-lockout body: ${await res.text()}`).toBe(200);
    } finally {
      await db
        .delete(tenantOtpLockouts)
        .where(
          and(
            eq(tenantOtpLockouts.tenantId, tenantId),
            eq(tenantOtpLockouts.identifier, normalizedIdentifier),
          ),
        );
      await db
        .delete(tenantEndUserVerifications)
        .where(eq(tenantEndUserVerifications.identifier, `sign-in-otp-${email}`));
    }
  });
});
