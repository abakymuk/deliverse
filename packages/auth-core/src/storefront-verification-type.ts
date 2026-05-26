/**
 * Derive `verification.type` from BA's `identifier` string conventions.
 *
 * BA 1.6.11 writes rows to the `verification` model (mapped to
 * `tenant_end_user_verifications` on the storefront) from two code paths:
 *
 *   1. emailOTP plugin — `toOTPIdentifier(type, email)` produces
 *      `${type}-otp-${email}` where type ∈ {'sign-in', 'email-verification',
 *      'forget-password'}.
 *      Source: node_modules/better-auth/dist/plugins/email-otp/utils.mjs:4-7
 *              node_modules/better-auth/dist/plugins/email-otp/routes.mjs:17-19
 *
 *   2. Non-OTP password-reset route — `reset-password:${token}`.
 *      Source: node_modules/better-auth/dist/api/routes/password.mjs:66-68
 *
 * Non-OTP email-verification uses JWT URLs and writes no DB row
 * (node_modules/better-auth/dist/api/routes/email-verification.mjs:12-34),
 * so it never reaches this mapper.
 */

export type VerificationType = 'otp_login' | 'email_verify' | 'password_reset';

export function deriveVerificationType(
  identifier: string | null | undefined,
): VerificationType | null {
  if (!identifier) return null;

  if (identifier.startsWith('sign-in-otp-')) return 'otp_login';
  if (identifier.startsWith('email-verification-otp-')) return 'email_verify';
  if (identifier.startsWith('forget-password-otp-')) return 'password_reset';
  if (identifier.startsWith('reset-password:')) return 'password_reset';

  return null;
}
