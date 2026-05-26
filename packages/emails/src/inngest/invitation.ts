/**
 * Inngest function — thin wrapper around `handleInvitationRequested` (DEL-13).
 *
 * All business logic lives in `../handlers/invitation-requested.ts`. Bound to
 * the event name + invoked inside `step.run(...)` so Inngest's retry +
 * idempotency policies apply.
 *
 * Registered ONCE via `./index.ts` (ADR-0009 decision #5).
 */

import type { InngestFunction } from 'inngest';
import type { InvitationRequestedData } from '../events';
import { handleInvitationRequested } from '../handlers/invitation-requested';
import { inngest } from './client';

export const invitationRequestedHandler: InngestFunction.Any = inngest.createFunction(
  {
    id: 'invitation-requested',
    name: 'Invitation email send',
    triggers: [{ event: 'email.invitation.requested' }],
  },
  async ({ event, step }) =>
    step.run('send', () => handleInvitationRequested(event.data as InvitationRequestedData)),
);
