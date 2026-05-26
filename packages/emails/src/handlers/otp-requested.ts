/**
 * Pure handler for `email.otp.requested` — the unit-testable surface.
 *
 * Split from the thin Inngest function wrapper in `../inngest/otp.ts` so
 * tests assert behavior without coupling to Inngest SDK internals. The
 * function is called inside `step.run('send', ...)` so Inngest's retry +
 * idempotency policy applies; throws from this function trigger Inngest's
 * default 4-retry exponential backoff (ADR-0009 decision #8).
 *
 * Flow:
 *   1. Parse incoming data via Zod (defense-in-depth — caller's typing isn't
 *      proof against runtime drift).
 *   2. Re-fetch brand + tenant context from the DB. Verifies
 *      `brand.tenantId === data.tenantId` (cross-tenant defense per
 *      docs/specs/email-delivery.md §10).
 *   3. Render the React Email template.
 *   4. Hand off to the Resend wrapper.
 *
 * The plaintext OTP is in `data.otp` and is SENSITIVE — see ADR-0009
 * decision #10. This function never logs `data` directly; if a future
 * change introduces a log line, redact `otp` to `'***'`.
 */

import { resolveEmailBrandContext } from '../brand-context';
import { sendEmail } from '../client';
import { type OtpRequestedData, otpRequestedEvent } from '../events';
import { OtpEmail } from '../templates/otp';

const SUBJECTS: Record<OtpRequestedData['type'], (brandName: string) => string> = {
  otp_login: (brand) => `Your sign-in code for ${brand}`,
  email_verify: (brand) => `Verify your email for ${brand}`,
  password_reset: (brand) => `Reset your password for ${brand}`,
};

export async function handleOtpRequested(data: OtpRequestedData): Promise<{ id: string }> {
  // Defense-in-depth: schema-validate at the boundary even though the
  // caller's TypeScript types should already guarantee shape.
  otpRequestedEvent.shape.data.parse(data);

  const { brand, tenant } = await resolveEmailBrandContext(data.brandSlug, data.tenantId);

  return sendEmail({
    to: data.email,
    subject: SUBJECTS[data.type](brand.name),
    react: OtpEmail({
      brand,
      tenant,
      otp: data.otp,
      type: data.type,
    }),
  });
}
