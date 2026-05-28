/**
 * Test helpers — Inngest dev event pollers.
 *
 * Extracted from `storefront-host-resolution.spec.ts` in DEL-25 PR 25c so
 * the new `food-hall.spec.ts` can reuse the helpers without importing
 * from another `.spec.ts` file (Playwright would collect + execute the
 * imported spec's tests inside the consumer's worker, doubling runs and
 * causing fixture-lifecycle chaos).
 *
 * Lives in `tests/e2e/helpers/` — explicitly NOT under a `.spec.ts`
 * filename so Playwright's testMatch glob skips it.
 *
 * Specs:
 *   - docs/specs/verification-brand-optional.md (DEL-23) — OTP poller.
 *   - Phase 3 Step 2 (forgot/reset next-param propagation) — password-
 *     reset poller, used by auth.spec.ts to verify the next-param
 *     round-trips into BA's email URL via `callbackURL`.
 */

const INNGEST_DEV_URL = 'http://localhost:8288/v1/events';

/**
 * Result of polling Inngest dev for an OTP event.
 *
 * `unreachable` — Inngest dev not running on :8288 (e.g., CI without
 *   `inngest-cli dev`). Caller should `test.skip()`.
 * `timeout` — Inngest reachable but matching event never appeared. Caller
 *   should THROW — signals a real regression in the BA
 *   `sendVerificationOTP` callback or the Inngest emit path.
 * `found` — plaintext OTP extracted from the event payload.
 */
export type OtpPollResult =
  | { status: 'found'; otp: string }
  | { status: 'unreachable' }
  | { status: 'timeout' };

/**
 * Poll Inngest dev tools for the latest `email.otp.requested` event
 * whose `data.email` matches `email`.
 *
 * BA stores OTPs hashed (`storeOTP: 'hashed'` in storefront.ts), so the
 * plaintext lives only in the Inngest event payload. Per-memory Inngest
 * indexing lag is 10-30s; default deadline 30s.
 */
export async function pollInngestDevForOtp(
  email: string,
  deadlineMs = 30_000,
): Promise<OtpPollResult> {
  // Probe once to distinguish unreachable from timeout.
  try {
    const probe = await fetch(
      `${INNGEST_DEV_URL}?event=email.otp.requested&limit=1`,
    );
    if (!probe.ok) return { status: 'unreachable' };
  } catch {
    return { status: 'unreachable' };
  }

  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(
        `${INNGEST_DEV_URL}?event=email.otp.requested&limit=20`,
      );
      if (!res.ok) return { status: 'unreachable' };
      const json = (await res.json()) as {
        data?: Array<{ data?: { email?: string; otp?: string } }>;
      };
      const match = json.data?.find((e) => e.data?.email === email);
      if (match?.data?.otp) return { status: 'found', otp: match.data.otp };
    } catch {
      // Network or JSON parse hiccup during polling — treat as
      // unreachable; do NOT crash the test. Probe above confirmed
      // initial reachability; this catches transient failures.
      return { status: 'unreachable' };
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return { status: 'timeout' };
}

/**
 * Result of polling Inngest dev for a password-reset event.
 *
 * `unreachable` — Inngest dev not running on :8288. Caller should `test.skip()`.
 * `timeout` — Inngest reachable but matching event never appeared. Caller
 *   should THROW — signals a real regression in BA's `sendResetPassword`
 *   callback or the Inngest emit path.
 * `found` — the full reset URL extracted from the event payload (the URL
 *   that's placed in the email). Phase 3 Step 2 tests assert that this
 *   URL's `callbackURL` query param contains the `next` value the form was
 *   composed with.
 */
export type PasswordResetPollResult =
  | { status: 'found'; url: string }
  | { status: 'unreachable' }
  | { status: 'timeout' };

/**
 * Poll Inngest dev for the latest `email.password_reset.requested` event
 * whose `data.email` matches `email`.
 *
 * Used by Phase 3 Step 2 e2e tests to verify the next-param round-trips
 * into BA's email URL via `callbackURL`. The BA-composed URL shape (per
 * `dist/api/routes/password.mjs`):
 *
 *   <storefrontBaseURL>/reset-password/<token>?callbackURL=<encoded-redirectTo>
 *
 * The forgot-password form composes `redirectTo` as
 * `/reset-password?next=<safe-next>`, so the encoded callbackURL contains
 * the next-param. Same indexing-lag concern as OTP polling (10-30s);
 * default deadline 30s.
 */
export async function pollInngestDevForPasswordReset(
  email: string,
  deadlineMs = 30_000,
): Promise<PasswordResetPollResult> {
  try {
    const probe = await fetch(
      `${INNGEST_DEV_URL}?event=email.password_reset.requested&limit=1`,
    );
    if (!probe.ok) return { status: 'unreachable' };
  } catch {
    return { status: 'unreachable' };
  }

  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(
        `${INNGEST_DEV_URL}?event=email.password_reset.requested&limit=20`,
      );
      if (!res.ok) return { status: 'unreachable' };
      const json = (await res.json()) as {
        data?: Array<{ data?: { email?: string; url?: string } }>;
      };
      const match = json.data?.find((e) => e.data?.email === email);
      if (match?.data?.url) return { status: 'found', url: match.data.url };
    } catch {
      return { status: 'unreachable' };
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return { status: 'timeout' };
}
