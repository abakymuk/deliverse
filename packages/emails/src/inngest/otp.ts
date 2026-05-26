/**
 * Inngest function — thin wrapper around the pure handler.
 *
 * All business logic lives in `../handlers/otp-requested.ts`. This file's
 * only job is to bind the function to the event name and run it inside
 * `step.run(...)` so Inngest's retry + idempotency policies apply.
 *
 * Registered ONCE in `apps/platform/src/app/api/inngest/route.ts`. Per
 * ADR-0009 decision #5, registering from a second `/api/inngest` handler
 * would cause duplicate sends.
 */

import type { InngestFunction } from 'inngest';
import type { OtpRequestedData } from '../events';
import { handleOtpRequested } from '../handlers/otp-requested';
import { inngest } from './client';

export const otpRequestedHandler: InngestFunction.Any = inngest.createFunction(
  {
    id: 'otp-requested',
    name: 'OTP email send',
    triggers: [{ event: 'email.otp.requested' }],
  },
  async ({ event, step }) =>
    step.run('send', () => handleOtpRequested(event.data as OtpRequestedData)),
);
