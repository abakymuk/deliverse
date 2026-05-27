/**
 * Inngest event schemas — single source of truth for the shape of every
 * transactional-email event the workspace emits.
 *
 * Each event is a Zod object so the handler can re-validate at the boundary;
 * the inferred TypeScript types are what callers `satisfies`-check against
 * at the `inngest.send(...)` call site.
 *
 * Shape per docs/specs/email-delivery.md §6 + docs/specs/ba-brand-optional.md (DEL-22):
 *   - OTP: storefront-only. Brand-mode payloads carry brandSlug (legacy,
 *     mode-less for back-compat with in-flight events). Tenant-mode payloads
 *     carry mode: 'tenant' + storefrontId + storefrontSlug.
 *   - Password reset: outer union of platform vs storefront; the storefront
 *     leg is itself a union of brand-mode (legacy, mode-less) vs tenant-mode.
 *   - Email verification: discriminated union by `instance`. Today only the
 *     `platform` variant exists — storefront uses OTP for verification. The
 *     union shape is kept for forward-compat (DEL-6 spec §4 decision #1).
 *
 * Back-compat note (DEL-22): all brand-mode storefront payloads remain
 * mode-less so that any in-flight Inngest events emitted by the prior
 * deploy parse without modification. Tenant-mode is additive.
 */

import { z } from 'zod';

// ── OTP (storefront only — DEL-5, extended for DEL-22 tenant-mode) ────────

const otpStorefrontBrand = z.object({
  email: z.string().email(),
  /** SENSITIVE: plaintext 6-digit code — never log, never echo to error messages. */
  otp: z.string().regex(/^\d{6}$/),
  type: z.enum(['otp_login', 'email_verify', 'password_reset']),
  tenantId: z.string().uuid(),
  brandSlug: z.string().min(1),
  // NO `mode` field — verbatim today's shape for back-compat with queued events.
});

const otpStorefrontTenant = z.object({
  email: z.string().email(),
  otp: z.string().regex(/^\d{6}$/),
  type: z.enum(['otp_login', 'email_verify', 'password_reset']),
  tenantId: z.string().uuid(),
  mode: z.literal('tenant'),
  storefrontId: z.string().uuid(),
  storefrontSlug: z.string().min(1),
});

export const otpRequestedEvent = z.object({
  name: z.literal('email.otp.requested'),
  // z.union (not z.discriminatedUnion on `mode`): brand-mode payloads have
  // no `mode` field, so the discriminator must be shape-based.
  data: z.union([otpStorefrontBrand, otpStorefrontTenant]),
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

// ── Password reset (platform + storefront, brand + tenant) — DEL-6 / DEL-22 ─

const platformPasswordReset = transactionalEmailCommon.extend({
  instance: z.literal('platform'),
});

const storefrontBrandPasswordReset = transactionalEmailCommon.extend({
  instance: z.literal('storefront'),
  tenantId: z.string().uuid(),
  brandSlug: z.string().min(1),
  // NO `mode` field — verbatim today's shape for back-compat (DEL-22).
});

const storefrontTenantPasswordReset = transactionalEmailCommon.extend({
  instance: z.literal('storefront'),
  mode: z.literal('tenant'),
  tenantId: z.string().uuid(),
  storefrontId: z.string().uuid(),
  storefrontSlug: z.string().min(1),
});

export const passwordResetRequestedEvent = z.object({
  name: z.literal('email.password_reset.requested'),
  // Outer union — platform has no `mode` and can't share a discriminator
  // with storefront. Inner union (brand vs tenant) is shape-based so legacy
  // brand-mode payloads (no `mode` field) still parse (DEL-22).
  data: z.union([
    platformPasswordReset,
    z.union([storefrontBrandPasswordReset, storefrontTenantPasswordReset]),
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

// ── Invitation (platform only — DEL-13) ────────────────────────────────────
//
// Does NOT extend `transactionalEmailCommon` — invitation recipients haven't
// signed up yet (no `platform_users` row to reference for `userId`).
//
// Deliberate exception from DEL-6 decision #2 ("url only — no token"):
// `invitationId` is carried alongside `url`. The DEL-6 case was about
// secret-bearing reset tokens; the invitation ID is lower-risk because BA's
// accept path requires a signed-in, email-verified user whose email matches
// the invitation row — the ID alone doesn't grant acceptance. Still
// sensitive-ish: don't routinely log the full URL OR the raw `invitationId`
// unless needed for debugging/audit.
//
// `role` is plumbed through for future copy/auditing use ("you've been
// invited as a manager"); BA passes it on the callback, cheap to carry now.

export const invitationRequestedEvent = z.object({
  name: z.literal('email.invitation.requested'),
  data: z.discriminatedUnion('instance', [
    z.object({
      instance: z.literal('platform'),
      email: z.string().email(),
      invitationId: z.string().uuid(),
      role: z.string().min(1),
      inviterName: z.string().min(1),
      organizationName: z.string().min(1),
      url: z.string().url(),
    }),
  ]),
});

export type InvitationRequestedEvent = z.infer<typeof invitationRequestedEvent>;
export type InvitationRequestedData = InvitationRequestedEvent['data'];
