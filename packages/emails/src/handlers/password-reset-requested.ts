/**
 * Pure handler for `email.password_reset.requested` — same shape as the OTP
 * handler from DEL-5.
 *
 * Switches on `data.instance` first, then on payload mode (DEL-22):
 *   - `'platform'`: skip resolver, render neutral "Deliverse" template, subject
 *     "Reset your Deliverse password".
 *   - `'storefront'` + mode 'tenant' (DEL-22): resolve storefront context,
 *     subject includes storefront name, render tenant-default branding from
 *     storefront.brandingJson + tenants fallback.
 *   - `'storefront'` + no mode (legacy, brand-mode): resolve brand context
 *     (with tenant-ownership defense per DEL-4 §10), subject includes the
 *     brand name, template renders the brand-themed header.
 *
 * Called inside `step.run('send', ...)` so Inngest's default retry policy
 * (4 attempts, exponential backoff) covers transient failures.
 */

import {
  resolveEmailBrandContext,
  resolveTenantStorefrontEmailContext,
} from '../brand-context';
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
    // Tenant-mode is the only storefront variant carrying `mode`; brand-mode
    // is mode-less (back-compat with in-flight events). `'mode' in data` is
    // the sole discriminator and lets TypeScript narrow without a compound
    // predicate that would defeat narrowing.
    if ('mode' in data) {
      const { storefront, tenant } = await resolveTenantStorefrontEmailContext(
        data.storefrontId,
        data.tenantId,
      );
      return sendEmail({
        to: data.email,
        subject: `Reset your password for ${storefront.name}`,
        react: PasswordResetEmail({
          instance: 'storefront',
          mode: 'tenant',
          storefront,
          tenant,
          url: data.url,
        }),
      });
    }

    // Brand-mode (default — back-compat with in-flight events lacking `mode`).
    const { brand, tenant } = await resolveEmailBrandContext(data.brandSlug, data.tenantId);
    return sendEmail({
      to: data.email,
      subject: `Reset your password for ${brand.name}`,
      react: PasswordResetEmail({
        instance: 'storefront',
        mode: 'brand',
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
