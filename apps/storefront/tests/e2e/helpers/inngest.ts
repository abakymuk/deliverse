/**
 * Test helpers — Inngest dev OTP poller.
 *
 * Extracted from `storefront-host-resolution.spec.ts` in DEL-25 PR 25c so
 * the new `food-hall.spec.ts` can reuse the helper without importing
 * from another `.spec.ts` file (Playwright would collect + execute the
 * imported spec's tests inside the consumer's worker, doubling runs and
 * causing fixture-lifecycle chaos).
 *
 * Lives in `tests/e2e/helpers/` — explicitly NOT under a `.spec.ts`
 * filename so Playwright's testMatch glob skips it.
 *
 * Spec: docs/specs/verification-brand-optional.md (DEL-23).
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
