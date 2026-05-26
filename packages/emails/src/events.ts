/**
 * Inngest event schemas — single source of truth for the shape of every
 * transactional-email event the workspace emits.
 *
 * Each event is a Zod object so the handler can re-validate at the boundary;
 * the inferred TypeScript types are what callers `satisfies`-check against
 * at the `inngest.send(...)` call site.
 *
 * Shape per docs/specs/email-delivery.md §6:
 *   - OTP: storefront-only (always carries tenantId + brandSlug).
 *   - Password reset: discriminated union by `instance` (platform vs storefront).
 *   - Email verification: discriminated union by `instance`. Today only the
 *     `platform` variant exists — storefront uses OTP for verification. The
 *     union shape is kept for forward-compat (DEL-6 spec §4 decision #1).
 */

import { z } from 'zod';

// ── OTP (storefront only — DEL-5) ─────────────────────────────────────────

export const otpRequestedEvent = z.object({
  name: z.literal('email.otp.requested'),
  data: z.object({
    email: z.string().email(),
    /** SENSITIVE: plaintext 6-digit code — never log, never echo to error messages. */
    otp: z.string().regex(/^\d{6}$/),
    type: z.enum(['otp_login', 'email_verify', 'password_reset']),
    tenantId: z.string().uuid(),
    brandSlug: z.string().min(1),
  }),
});

export type OtpRequestedEvent = z.infer<typeof otpRequestedEvent>;
export type OtpRequestedData = OtpRequestedEvent['data'];

// ── Shared shape for password-reset + email-verification events ───────────
//
// Both events carry the recipient + the actionable URL (which embeds the
// token internally). The raw `token` BA also passes to the callback is NOT
// included in the event payload — `url` is the user-facing surface, the
// token is sensitive, and including it widens the event-store exposure for
// zero benefit (DEL-6 spec §4 decision #2).

const transactionalEmailCommon = z.object({
  email: z.string().email(),
  userId: z.string().uuid(),
  url: z.string().url(),
});

// ── Password reset (platform + storefront) — DEL-6 ────────────────────────

export const passwordResetRequestedEvent = z.object({
  name: z.literal('email.password_reset.requested'),
  data: z.discriminatedUnion('instance', [
    transactionalEmailCommon.extend({ instance: z.literal('platform') }),
    transactionalEmailCommon.extend({
      instance: z.literal('storefront'),
      tenantId: z.string().uuid(),
      brandSlug: z.string().min(1),
    }),
  ]),
});

export type PasswordResetRequestedEvent = z.infer<typeof passwordResetRequestedEvent>;
export type PasswordResetRequestedData = PasswordResetRequestedEvent['data'];

// ── Email verification (platform only today; union kept for forward-compat) ─

export const emailVerificationRequestedEvent = z.object({
  name: z.literal('email.email_verification.requested'),
  data: z.discriminatedUnion('instance', [
    transactionalEmailCommon.extend({ instance: z.literal('platform') }),
  ]),
});

export type EmailVerificationRequestedEvent = z.infer<typeof emailVerificationRequestedEvent>;
export type EmailVerificationRequestedData = EmailVerificationRequestedEvent['data'];
