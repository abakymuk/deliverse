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

const apiKey = process.env.RESEND_API_KEY;
const fromEmail = process.env.RESEND_FROM_EMAIL;
const isProd = process.env.NODE_ENV === 'production';

if (isProd) {
  if (!apiKey) {
    throw new Error('emails: RESEND_API_KEY is required when NODE_ENV=production');
  }
  if (!fromEmail) {
    throw new Error('emails: RESEND_FROM_EMAIL is required when NODE_ENV=production');
  }
}

const resend = apiKey ? new Resend(apiKey) : null;

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

export async function sendEmail(args: SendEmailArgs): Promise<{ id: string }> {
  if (!resend) {
    console.warn(`[DEV] would send: ${JSON.stringify({ to: args.to, subject: args.subject })}`);
    return { id: 'dev-noop' };
  }

  const from = fromEmail ?? 'onboarding@resend.dev';
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
