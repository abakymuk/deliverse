/**
 * Pure handler for `email.invitation.requested` — platform-only (DEL-13).
 *
 * Mirrors `email-verification-requested.ts`: schema-parse at the boundary,
 * single switch arm today for forward-compat. No brand-context resolver call
 * — invitation is platform-only per AC #4 ("no brand context").
 *
 * Called inside `step.run('send', ...)` so Inngest's default retry policy
 * (4 attempts, exponential backoff) covers transient failures.
 */

import { sendEmail } from '../client';
import { type InvitationRequestedData, invitationRequestedEvent } from '../events';
import { InvitationEmail } from '../templates/invitation';

export async function handleInvitationRequested(
  data: InvitationRequestedData,
): Promise<{ id: string }> {
  invitationRequestedEvent.shape.data.parse(data);

  switch (data.instance) {
    case 'platform':
      return sendEmail({
        to: data.email,
        subject: `You're invited to join ${data.organizationName} on Deliverse`,
        react: InvitationEmail({
          instance: 'platform',
          inviterName: data.inviterName,
          organizationName: data.organizationName,
          url: data.url,
        }),
      });
  }
}
