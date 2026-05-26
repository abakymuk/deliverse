/**
 * Unit tests for `handleOtpRequested` (the pure-function handler).
 *
 * Tests target the pure function, NOT the Inngest SDK wrapper. The SDK
 * wrapper at `src/inngest/otp.ts` is one line — covered by manual
 * verification in dev (PR description checklist).
 *
 * Fixtures use the seeded Hospitality Group tenant + Pizza Express brand
 * to match the manual dev verification at `pizza-express.localhost:3001`.
 */

import { render } from '@react-email/render';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { OtpRequestedData } from '../src/events';

// ── Module mocks (must be declared before importing the SUT) ──────────────

vi.mock('../src/brand-context', () => ({
  resolveEmailBrandContext: vi.fn(),
  BrandResolutionError: class BrandResolutionError extends Error {},
}));

vi.mock('../src/client', () => ({
  sendEmail: vi.fn(),
  EmailSendError: class EmailSendError extends Error {},
}));

const { handleOtpRequested } = await import('../src/handlers/otp-requested');
const { resolveEmailBrandContext } = await import('../src/brand-context');
const { sendEmail } = await import('../src/client');

const resolveMock = vi.mocked(resolveEmailBrandContext);
const sendMock = vi.mocked(sendEmail);

// ── Fixtures (valid v4 UUIDs — Zod 4 enforces RFC 4122) ───────────────────

const TENANT_ID = '11111111-1111-4111-9111-111111111111';
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

const validData: OtpRequestedData = {
  email: 'john@example.com',
  otp: '123456',
  type: 'otp_login',
  tenantId: TENANT_ID,
  brandSlug: 'pizza-express',
};

beforeEach(() => {
  resolveMock.mockReset();
  sendMock.mockReset();
});

describe('handleOtpRequested', () => {
  it('resolves brand context, renders the template, and calls sendEmail with the right shape', async () => {
    resolveMock.mockResolvedValue({ brand: brandFixture, tenant: tenantFixture });
    sendMock.mockResolvedValue({ id: 'resend-id-abc' });

    const result = await handleOtpRequested(validData);

    expect(result).toEqual({ id: 'resend-id-abc' });
    expect(resolveMock).toHaveBeenCalledWith('pizza-express', TENANT_ID);
    expect(sendMock).toHaveBeenCalledTimes(1);

    const args = sendMock.mock.calls[0]?.[0];
    expect(args).toBeDefined();
    expect(args?.to).toBe('john@example.com');
    expect(args?.subject).toBe('Your sign-in code for Pizza Express');
    expect(args?.react).toBeTruthy();
  });

  it('rendered template contains the 6-digit code and the brand name', async () => {
    resolveMock.mockResolvedValue({ brand: brandFixture, tenant: tenantFixture });
    sendMock.mockResolvedValue({ id: 'x' });

    await handleOtpRequested(validData);

    const args = sendMock.mock.calls[0]?.[0];
    if (!args) throw new Error('sendMock was not called');
    const html = await render(args.react);
    expect(html).toContain('123456');
    expect(html).toContain('Pizza Express');
  });

  it('picks the right subject per type', async () => {
    resolveMock.mockResolvedValue({ brand: brandFixture, tenant: tenantFixture });
    sendMock.mockResolvedValue({ id: 'x' });

    await handleOtpRequested({ ...validData, type: 'email_verify' });
    expect(sendMock.mock.calls[0]?.[0]?.subject).toBe('Verify your email for Pizza Express');

    sendMock.mockClear();
    await handleOtpRequested({ ...validData, type: 'password_reset' });
    expect(sendMock.mock.calls[0]?.[0]?.subject).toBe('Reset your password for Pizza Express');
  });

  it('propagates resolver throws (so Inngest retries kick in)', async () => {
    const boom = new Error('emails: brand resolution failed — boom');
    resolveMock.mockRejectedValue(boom);

    await expect(handleOtpRequested(validData)).rejects.toThrow('brand resolution failed');
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('rejects malformed OTP at the schema boundary (defense-in-depth)', async () => {
    resolveMock.mockResolvedValue({ brand: brandFixture, tenant: tenantFixture });

    await expect(handleOtpRequested({ ...validData, otp: 'abcdef' })).rejects.toThrow();
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('rejects non-UUID tenantId at the schema boundary', async () => {
    resolveMock.mockResolvedValue({ brand: brandFixture, tenant: tenantFixture });

    await expect(handleOtpRequested({ ...validData, tenantId: 'not-a-uuid' })).rejects.toThrow();
    expect(sendMock).not.toHaveBeenCalled();
  });
});
