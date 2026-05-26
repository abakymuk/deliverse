/**
 * Unit tests for `handleEmailVerificationRequested` — platform variant.
 *
 * Single-variant today (no storefront non-OTP email verification); when/if a
 * storefront variant is added, copy the storefront pattern from
 * `password-reset.test.ts`.
 */

import { render } from '@react-email/render';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { EmailVerificationRequestedData } from '../src/events';

vi.mock('../src/client', () => ({
  sendEmail: vi.fn(),
  EmailSendError: class EmailSendError extends Error {},
}));

const { handleEmailVerificationRequested } = await import(
  '../src/handlers/email-verification-requested'
);
const { sendEmail } = await import('../src/client');

const sendMock = vi.mocked(sendEmail);

const USER_ID = '33333333-3333-4333-9333-333333333333';
const VERIFY_URL = 'https://admin.deliverse.app/api/auth/verify-email?token=abc&callbackURL=/';

beforeEach(() => {
  sendMock.mockReset();
});

describe('handleEmailVerificationRequested — platform variant', () => {
  const validData: EmailVerificationRequestedData = {
    instance: 'platform',
    email: 'newuser@example.com',
    userId: USER_ID,
    url: VERIFY_URL,
  };

  it('sends with neutral "Deliverse" subject and the verification URL in the body', async () => {
    sendMock.mockResolvedValue({ id: 'resend-id-ghi' });

    const result = await handleEmailVerificationRequested(validData);

    expect(result).toEqual({ id: 'resend-id-ghi' });
    expect(sendMock).toHaveBeenCalledTimes(1);

    const args = sendMock.mock.calls[0]?.[0];
    expect(args?.to).toBe('newuser@example.com');
    expect(args?.subject).toBe('Verify your Deliverse email');

    if (!args) throw new Error('sendMock was not called');
    const html = await render(args.react);
    expect(html).toContain('Deliverse');
    expect(html).toContain('Verify your email');
    // URL is rendered inside `href=` with `&` entity-encoded to `&amp;`;
    // check the unique unencoded portion (path + token) to avoid encoding
    // brittleness.
    expect(html).toContain('/api/auth/verify-email?token=abc');
  });

  it('rejects malformed payload at the schema boundary', async () => {
    await expect(
      handleEmailVerificationRequested({
        instance: 'platform',
        email: 'not-an-email',
        userId: USER_ID,
        url: VERIFY_URL,
      } as EmailVerificationRequestedData),
    ).rejects.toThrow();
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('rejects non-URL url', async () => {
    await expect(
      handleEmailVerificationRequested({
        instance: 'platform',
        email: 'newuser@example.com',
        userId: USER_ID,
        url: 'not a url',
      } as EmailVerificationRequestedData),
    ).rejects.toThrow();
    expect(sendMock).not.toHaveBeenCalled();
  });
});
