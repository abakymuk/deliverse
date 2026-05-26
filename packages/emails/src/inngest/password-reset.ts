/**
 * Inngest function — thin wrapper around `handlePasswordResetRequested`.
 *
 * All business logic lives in `../handlers/password-reset-requested.ts`. This
 * file's only job is to bind the function to the event name and run it inside
 * `step.run(...)` so Inngest's retry + idempotency policies apply.
 *
 * Registered ONCE in `apps/platform/src/app/api/inngest/route.ts` via the
 * registry in `./index.ts` (ADR-0009 decision #5).
 */

import type { InngestFunction } from 'inngest';
import type { PasswordResetRequestedData } from '../events';
import { handlePasswordResetRequested } from '../handlers/password-reset-requested';
import { inngest } from './client';

export const passwordResetRequestedHandler: InngestFunction.Any = inngest.createFunction(
  {
    id: 'password-reset-requested',
    name: 'Password reset email send',
    triggers: [{ event: 'email.password_reset.requested' }],
  },
  async ({ event, step }) =>
    step.run('send', () => handlePasswordResetRequested(event.data as PasswordResetRequestedData)),
);
