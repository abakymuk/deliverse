/**
 * Pure handler for `email.password_reset.requested` — same shape as the OTP
 * handler from DEL-5.
 *
 * Switches on `data.instance`:
 *   - `'storefront'`: resolve brand context (with tenant-ownership defense per
 *     DEL-4 §10), subject includes the brand name, template renders the
 *     brand-themed header.
 *   - `'platform'`: skip resolver, render neutral "Deliverse" template, subject
 *     "Reset your Deliverse password".
 *
 * Called inside `step.run('send', ...)` so Inngest's default retry policy
 * (4 attempts, exponential backoff) covers transient failures.
 */

import { resolveEmailBrandContext } from '../brand-context';
import { sendEmail } from '../client';
import { type PasswordResetRequestedData, passwordResetRequestedEvent } from '../events';
import { PasswordResetEmail } from '../templates/password-reset';

export async function handlePasswordResetRequested(
  data: PasswordResetRequestedData,
): Promise<{ id: string }> {
  // Defense-in-depth: schema-validate at the boundary even though the
  // caller's TypeScript types should already guarantee shape.
  passwordResetRequestedEvent.shape.data.parse(data);

  if (data.instance === 'storefront') {
    const { brand, tenant } = await resolveEmailBrandContext(data.brandSlug, data.tenantId);
    return sendEmail({
      to: data.email,
      subject: `Reset your password for ${brand.name}`,
      react: PasswordResetEmail({
        instance: 'storefront',
        brand,
        tenant,
        url: data.url,
      }),
    });
  }

  // instance: 'platform' — neutral Deliverse branding.
  return sendEmail({
    to: data.email,
    subject: 'Reset your Deliverse password',
    react: PasswordResetEmail({ instance: 'platform', url: data.url }),
  });
}
