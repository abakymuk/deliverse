/**
 * Inngest event schemas — single source of truth for the shape of every
 * transactional-email event the workspace emits.
 *
 * Each event is a Zod object so the handler can re-validate at the boundary;
 * the inferred TypeScript types are what callers `satisfies`-check against
 * at the `inngest.send(...)` call site.
 *
 * DEL-5 ships only `email.otp.requested`. DEL-6 will add
 * `email.password_reset.requested` + `email.email_verification.requested`
 * as discriminated unions per docs/specs/email-delivery.md §6.
 */

import { z } from 'zod';

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
