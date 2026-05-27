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
 *   2. Branch on payload shape (DEL-22):
 *        - Brand-mode (legacy, no `mode` field): resolve brand context, render
 *          brand-themed template.
 *        - Tenant-mode (`mode: 'tenant'`): resolve storefront context, render
 *          tenant-default branding from storefront.brandingJson + tenants fallback.
 *   3. Render the React Email template.
 *   4. Hand off to the Resend wrapper.
 *
 * The plaintext OTP is in `data.otp` and is SENSITIVE — see ADR-0009
 * decision #10. This function never logs `data` directly; if a future
 * change introduces a log line, redact `otp` to `'***'`.
 */

import {
  resolveEmailBrandContext,
  resolveTenantStorefrontEmailContext,
} from '../brand-context';
import { sendEmail } from '../client';
import { type OtpRequestedData, otpRequestedEvent } from '../events';
import { OtpEmail } from '../templates/otp';

// DEL-22: subjects parameterized by displayName (brand.name in brand-mode,
// storefront.name in tenant-mode). Brand-mode strings are verbatim today's
// wording to preserve byte-equivalence for existing brand-host emails.
const SUBJECTS: Record<OtpRequestedData['type'], (displayName: string) => string> = {
  otp_login: (name) => `Your sign-in code for ${name}`,
  email_verify: (name) => `Verify your email for ${name}`,
  password_reset: (name) => `Reset your password for ${name}`,
};

export async function handleOtpRequested(data: OtpRequestedData): Promise<{ id: string }> {
  // Defense-in-depth: schema-validate at the boundary even though the
  // caller's TypeScript types should already guarantee shape.
  otpRequestedEvent.shape.data.parse(data);

  // Tenant-mode is the only variant carrying `mode`; brand-mode is mode-less
  // (back-compat with in-flight events). `'mode' in data` is therefore the
  // sole discriminator and lets TypeScript narrow without a compound predicate.
  if ('mode' in data) {
    const { storefront, tenant } = await resolveTenantStorefrontEmailContext(
      data.storefrontId,
      data.tenantId,
    );
    return sendEmail({
      to: data.email,
      subject: SUBJECTS[data.type](storefront.name),
      react: OtpEmail({
        mode: 'tenant',
        storefront,
        tenant,
        otp: data.otp,
        type: data.type,
      }),
    });
  }

  // Brand-mode (default — back-compat with in-flight events lacking `mode`).
  const { brand, tenant } = await resolveEmailBrandContext(data.brandSlug, data.tenantId);
  return sendEmail({
    to: data.email,
    subject: SUBJECTS[data.type](brand.name),
    react: OtpEmail({
      mode: 'brand',
      brand,
      tenant,
      otp: data.otp,
      type: data.type,
    }),
  });
}
