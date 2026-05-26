/**
 * Pure handler for `email.email_verification.requested`.
 *
 * Platform-only today, but switches on `data.instance` for symmetry with
 * `password-reset-requested.ts`. A future storefront variant becomes a one-case
 * addition to this switch + the discriminated union in `../events.ts` (DEL-6
 * spec §4 decision #5).
 *
 * Called inside `step.run('send', ...)` so Inngest's default retry policy
 * (4 attempts, exponential backoff) covers transient failures.
 */

import { sendEmail } from '../client';
import { type EmailVerificationRequestedData, emailVerificationRequestedEvent } from '../events';
import { EmailVerificationEmail } from '../templates/email-verify';

export async function handleEmailVerificationRequested(
  data: EmailVerificationRequestedData,
): Promise<{ id: string }> {
  emailVerificationRequestedEvent.shape.data.parse(data);

  switch (data.instance) {
    case 'platform':
      return sendEmail({
        to: data.email,
        subject: 'Verify your Deliverse email',
        react: EmailVerificationEmail({ instance: 'platform', url: data.url }),
      });
  }
}
