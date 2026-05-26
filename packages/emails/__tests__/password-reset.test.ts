/**
 * Unit tests for `handlePasswordResetRequested` — both `instance` variants.
 *
 * Mirrors the OTP test pattern: top-level `vi.mock` for brand-context + client,
 * `await import` after mocks, render assertion via `@react-email/render`.
 */

import { render } from '@react-email/render';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PasswordResetRequestedData } from '../src/events';

vi.mock('../src/brand-context', () => ({
  resolveEmailBrandContext: vi.fn(),
  BrandResolutionError: class BrandResolutionError extends Error {},
}));

vi.mock('../src/client', () => ({
  sendEmail: vi.fn(),
  EmailSendError: class EmailSendError extends Error {},
}));

const { handlePasswordResetRequested } = await import('../src/handlers/password-reset-requested');
const { resolveEmailBrandContext } = await import('../src/brand-context');
const { sendEmail } = await import('../src/client');

const resolveMock = vi.mocked(resolveEmailBrandContext);
const sendMock = vi.mocked(sendEmail);

const TENANT_ID = '11111111-1111-4111-9111-111111111111';
const USER_ID = '33333333-3333-4333-9333-333333333333';
const BRAND_ID = '22222222-2222-4222-9222-222222222222';

const tenantFixture = {
  id: TENANT_ID,
  slug: 'hospitality-group',
  name: 'Hospitality Group',
  logo: null,
  status: 'active' as const,
  metadata: null,
  createdAt: new Date('2026-01-01'),
  updatedAt: new Date('2026-01-01'),
  deletedAt: null,
};

const brandFixture = {
  id: BRAND_ID,
  tenantId: TENANT_ID,
  slug: 'pizza-express',
  name: 'Pizza Express',
  brandingJson: { primary: '#dc2626' },
  isActive: true,
  createdAt: new Date('2026-01-01'),
  updatedAt: new Date('2026-01-01'),
  deletedAt: null,
};

const RESET_URL = 'https://pizza-express.deliverse.app/reset-password?token=abc';

beforeEach(() => {
  resolveMock.mockReset();
  sendMock.mockReset();
});

describe('handlePasswordResetRequested — storefront variant', () => {
  const storefrontData: PasswordResetRequestedData = {
    instance: 'storefront',
    email: 'jane@example.com',
    userId: USER_ID,
    url: RESET_URL,
    tenantId: TENANT_ID,
    brandSlug: 'pizza-express',
  };

  it('resolves brand context, renders branded template, calls sendEmail with brand-name subject', async () => {
    resolveMock.mockResolvedValue({ brand: brandFixture, tenant: tenantFixture });
    sendMock.mockResolvedValue({ id: 'resend-id-abc' });

    const result = await handlePasswordResetRequested(storefrontData);

    expect(result).toEqual({ id: 'resend-id-abc' });
    expect(resolveMock).toHaveBeenCalledWith('pizza-express', TENANT_ID);
    expect(sendMock).toHaveBeenCalledTimes(1);

    const args = sendMock.mock.calls[0]?.[0];
    expect(args).toBeDefined();
    expect(args?.to).toBe('jane@example.com');
    expect(args?.subject).toBe('Reset your password for Pizza Express');
    expect(args?.react).toBeTruthy();
  });

  it('rendered template contains the brand name and the reset URL', async () => {
    resolveMock.mockResolvedValue({ brand: brandFixture, tenant: tenantFixture });
    sendMock.mockResolvedValue({ id: 'x' });

    await handlePasswordResetRequested(storefrontData);

    const args = sendMock.mock.calls[0]?.[0];
    if (!args) throw new Error('sendMock was not called');
    const html = await render(args.react);
    expect(html).toContain('Pizza Express');
    expect(html).toContain(RESET_URL);
  });

  it('propagates resolver throws (so Inngest retries kick in)', async () => {
    resolveMock.mockRejectedValue(new Error('emails: brand resolution failed — boom'));
    await expect(handlePasswordResetRequested(storefrontData)).rejects.toThrow(
      'brand resolution failed',
    );
    expect(sendMock).not.toHaveBeenCalled();
  });
});

describe('handlePasswordResetRequested — platform variant', () => {
  const platformData: PasswordResetRequestedData = {
    instance: 'platform',
    email: 'admin@test.local',
    userId: USER_ID,
    url: 'https://admin.deliverse.app/reset-password?token=xyz',
  };

  it('skips the resolver and sends with neutral "Deliverse" subject', async () => {
    sendMock.mockResolvedValue({ id: 'resend-id-def' });

    const result = await handlePasswordResetRequested(platformData);

    expect(result).toEqual({ id: 'resend-id-def' });
    expect(resolveMock).not.toHaveBeenCalled();
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock.mock.calls[0]?.[0]?.subject).toBe('Reset your Deliverse password');
  });

  it('rendered template contains "Deliverse" and the reset URL — no brand or tenant fixture', async () => {
    sendMock.mockResolvedValue({ id: 'x' });

    await handlePasswordResetRequested(platformData);

    const args = sendMock.mock.calls[0]?.[0];
    if (!args) throw new Error('sendMock was not called');
    const html = await render(args.react);
    expect(html).toContain('Deliverse');
    expect(html).toContain(platformData.url);
    expect(html).not.toContain('Pizza Express');
    expect(html).not.toContain('Hospitality Group');
  });
});

describe('handlePasswordResetRequested — schema boundary', () => {
  it('rejects non-UUID userId', async () => {
    await expect(
      handlePasswordResetRequested({
        instance: 'platform',
        email: 'admin@test.local',
        userId: 'not-a-uuid',
        url: 'https://admin.deliverse.app/reset',
      }),
    ).rejects.toThrow();
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('rejects non-URL url', async () => {
    await expect(
      handlePasswordResetRequested({
        instance: 'platform',
        email: 'admin@test.local',
        userId: USER_ID,
        url: 'not a url',
      }),
    ).rejects.toThrow();
    expect(sendMock).not.toHaveBeenCalled();
  });
});
