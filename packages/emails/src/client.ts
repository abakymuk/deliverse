/**
 * Resend client wrapper — the single send point for the workspace.
 *
 * In production, `RESEND_API_KEY` + `RESEND_FROM_EMAIL` are required and the
 * wrapper throws at module load if either is missing.
 *
 * In dev/test, missing `RESEND_API_KEY` is allowed and the wrapper no-ops,
 * logging `[DEV] would send: { to, subject }` — NO body preview, since
 * email bodies regularly contain sensitive material (OTP codes, reset URLs).
 * This keeps OTP-leak prevention wrapper-side instead of relying on
 * caller-side redaction (docs/specs/otp-email.md §4 decision #4).
 *
 * Retries are NOT handled here — Inngest's default retry policy at the
 * function layer covers transient failures (ADR-0009 decision #8).
 */

import type { ReactElement } from 'react';
import { Resend } from 'resend';

export class EmailSendError extends Error {
  constructor(
    message: string,
    public override readonly cause?: unknown,
  ) {
    super(`emails: ${message}`);
    this.name = 'EmailSendError';
  }
}

export type SendEmailArgs = {
  to: string;
  subject: string;
  react: ReactElement;
  text?: string;
};

/**
 * Module-load is too early to throw on missing env. Next 16's `next build`
 * evaluates the App Router route graph with NODE_ENV=production set, which
 * would crash the build if RESEND_API_KEY isn't in the build environment
 * (it shouldn't have to be — the key only needs to be present at request
 * time on the deployed server). So defer the env check to first call.
 */
let resendInstance: Resend | null | undefined;

function getResend(): Resend | null {
  if (resendInstance !== undefined) return resendInstance;

  const apiKey = process.env.RESEND_API_KEY;
  const isProd = process.env.NODE_ENV === 'production';

  if (isProd) {
    if (!apiKey) {
      throw new EmailSendError('RESEND_API_KEY is required when NODE_ENV=production');
    }
    if (!process.env.RESEND_FROM_EMAIL) {
      throw new EmailSendError('RESEND_FROM_EMAIL is required when NODE_ENV=production');
    }
  }

  resendInstance = apiKey ? new Resend(apiKey) : null;
  return resendInstance;
}

export async function sendEmail(args: SendEmailArgs): Promise<{ id: string }> {
  const resend = getResend();
  if (!resend) {
    console.warn(`[DEV] would send: ${JSON.stringify({ to: args.to, subject: args.subject })}`);
    return { id: 'dev-noop' };
  }

  const from = process.env.RESEND_FROM_EMAIL ?? 'onboarding@resend.dev';
  const result = await resend.emails.send({
    from,
    to: args.to,
    subject: args.subject,
    react: args.react,
    text: args.text,
  });

  if (result.error) {
    throw new EmailSendError(`Resend rejected send — ${result.error.message}`, result.error);
  }
  if (!result.data?.id) {
    throw new EmailSendError('Resend returned no id');
  }
  return { id: result.data.id };
}
