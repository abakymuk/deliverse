/**
 * Unit tests for `handleInvitationRequested` (DEL-13) — platform variant.
 *
 * Mirrors `email-verify.test.ts`: top-level `vi.mock('../src/client')`,
 * `await import` after mocks, render assertion via `@react-email/render`.
 *
 * No `brand-context` mock — invitation is platform-only, the handler should
 * not import `brand-context` at all. (The strongest invariant is that
 * `handlers/invitation-requested.ts` does not have a `brand-context` import;
 * we don't need a runtime mock to assert it.)
 */

import { render } from '@react-email/render';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { InvitationRequestedData } from '../src/events';

vi.mock('../src/client', () => ({
  sendEmail: vi.fn(),
  EmailSendError: class EmailSendError extends Error {},
}));

const { handleInvitationRequested } = await import('../src/handlers/invitation-requested');
const { sendEmail } = await import('../src/client');

const sendMock = vi.mocked(sendEmail);

const INVITATION_ID = '44444444-4444-4444-8444-444444444444';
const INVITE_URL = `https://admin.deliverse.app/signup?token=${INVITATION_ID}`;

beforeEach(() => {
  sendMock.mockReset();
});

describe('handleInvitationRequested — platform variant', () => {
  const validData: InvitationRequestedData = {
    instance: 'platform',
    email: 'invitee@example.com',
    invitationId: INVITATION_ID,
    role: 'staff',
    inviterName: 'Ada Lovelace',
    organizationName: 'Hospitality Group',
    url: INVITE_URL,
  };

  it('sends with the org-name subject and the invite URL in the rendered body', async () => {
    sendMock.mockResolvedValue({ id: 'resend-id-jkl' });

    const result = await handleInvitationRequested(validData);

    expect(result).toEqual({ id: 'resend-id-jkl' });
    expect(sendMock).toHaveBeenCalledTimes(1);

    const args = sendMock.mock.calls[0]?.[0];
    expect(args?.to).toBe('invitee@example.com');
    expect(args?.subject).toBe(`You're invited to join Hospitality Group on Deliverse`);

    if (!args) throw new Error('sendMock was not called');
    const html = await render(args.react);
    // Neutral Deliverse header present (platform-only, no brand color).
    expect(html).toContain('Deliverse');
    // Body weaves both names + the org.
    expect(html).toContain('Hospitality Group');
    expect(html).toContain('Ada Lovelace');
    // Unique unencoded URL portion — avoids `&` entity-encoding brittleness.
    expect(html).toContain(`/signup?token=${INVITATION_ID}`);
  });

  it('renders the 48-hour expiry copy', async () => {
    sendMock.mockResolvedValue({ id: 'resend-id-mno' });

    await handleInvitationRequested(validData);

    const args = sendMock.mock.calls[0]?.[0];
    if (!args) throw new Error('sendMock was not called');
    const html = await render(args.react);
    expect(html).toContain('48 hours');
  });

  it('rejects an invalid email at the schema boundary', async () => {
    await expect(
      handleInvitationRequested({
        ...validData,
        email: 'not-an-email',
      } as InvitationRequestedData),
    ).rejects.toThrow();
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('rejects a non-URL url', async () => {
    await expect(
      handleInvitationRequested({
        ...validData,
        url: 'not a url',
      } as InvitationRequestedData),
    ).rejects.toThrow();
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('rejects a non-UUID invitationId', async () => {
    await expect(
      handleInvitationRequested({
        ...validData,
        invitationId: 'not-a-uuid',
      } as InvitationRequestedData),
    ).rejects.toThrow();
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('propagates sendEmail failures so Inngest retries kick in', async () => {
    sendMock.mockRejectedValue(new Error('resend: boom'));
    await expect(handleInvitationRequested(validData)).rejects.toThrow('resend: boom');
    expect(sendMock).toHaveBeenCalledTimes(1);
  });
});
