/**
 * Inngest function — thin wrapper around `handleEmailVerificationRequested`.
 *
 * All business logic lives in `../handlers/email-verification-requested.ts`.
 * Bound to the event name + invoked inside `step.run(...)` so Inngest's
 * retry + idempotency policies apply.
 *
 * Registered ONCE via `./index.ts` (ADR-0009 decision #5).
 */

import type { InngestFunction } from 'inngest';
import type { EmailVerificationRequestedData } from '../events';
import { handleEmailVerificationRequested } from '../handlers/email-verification-requested';
import { inngest } from './client';

export const emailVerificationRequestedHandler: InngestFunction.Any = inngest.createFunction(
  {
    id: 'email-verification-requested',
    name: 'Email verification email send',
    triggers: [{ event: 'email.email_verification.requested' }],
  },
  async ({ event, step }) =>
    step.run('send', () =>
      handleEmailVerificationRequested(event.data as EmailVerificationRequestedData),
    ),
);
