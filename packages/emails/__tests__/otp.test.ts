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
  resolveTenantStorefrontEmailContext: vi.fn(),
  BrandResolutionError: class BrandResolutionError extends Error {},
}));

vi.mock('../src/client', () => ({
  sendEmail: vi.fn(),
  EmailSendError: class EmailSendError extends Error {},
}));

const { handleOtpRequested } = await import('../src/handlers/otp-requested');
const { resolveEmailBrandContext, resolveTenantStorefrontEmailContext } = await import(
  '../src/brand-context'
);
const { sendEmail } = await import('../src/client');

const resolveMock = vi.mocked(resolveEmailBrandContext);
const resolveTenantMock = vi.mocked(resolveTenantStorefrontEmailContext);
const sendMock = vi.mocked(sendEmail);

// ── Fixtures (valid v4 UUIDs — Zod 4 enforces RFC 4122) ───────────────────

const TENANT_ID = '11111111-1111-4111-9111-111111111111';
const BRAND_ID = '22222222-2222-4222-9222-222222222222';
const STOREFRONT_ID = '33333333-3333-4333-9333-333333333333';

const tenantFixture = {
  id: TENANT_ID,
  slug: 'hospitality-group',
  name: 'Hospitality Group',
  logo: null,
  status: 'active' as const,
  metadata: null,
  stripeAccountId: null,
  stripeChargesEnabled: false,
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
  resolveTenantMock.mockReset();
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

// ── DEL-22 tenant-mode handler tests ──────────────────────────────────────

const storefrontFixture = {
  id: STOREFRONT_ID,
  tenantId: TENANT_ID,
  slug: 'oomi-kitchen-test',
  name: 'OOMI Kitchen Test',
  type: 'tenant' as const,
  primaryBrandId: null,
  brandingJson: { primary: '#16a34a', logo: 'https://cdn.example/oomi.png' },
  isActive: true,
  createdAt: new Date('2026-01-01'),
  updatedAt: new Date('2026-01-01'),
  deletedAt: null,
};

const tenantModeData: OtpRequestedData = {
  email: 'jane@example.com',
  otp: '654321',
  type: 'otp_login',
  tenantId: TENANT_ID,
  mode: 'tenant',
  storefrontId: STOREFRONT_ID,
  storefrontSlug: 'oomi-kitchen-test',
};

describe('handleOtpRequested — tenant mode (DEL-22)', () => {
  it('resolves storefront context (not brand context) and renders with storefront name', async () => {
    resolveTenantMock.mockResolvedValue({ storefront: storefrontFixture, tenant: tenantFixture });
    sendMock.mockResolvedValue({ id: 'resend-tenant-id' });

    const result = await handleOtpRequested(tenantModeData);

    expect(result).toEqual({ id: 'resend-tenant-id' });
    expect(resolveTenantMock).toHaveBeenCalledWith(STOREFRONT_ID, TENANT_ID);
    expect(resolveMock).not.toHaveBeenCalled(); // brand resolver MUST NOT fire in tenant mode

    const args = sendMock.mock.calls[0]?.[0];
    expect(args?.to).toBe('jane@example.com');
    expect(args?.subject).toBe('Your sign-in code for OOMI Kitchen Test');
  });

  it('rendered template uses storefront branding (logo + primary color from storefront.brandingJson)', async () => {
    resolveTenantMock.mockResolvedValue({ storefront: storefrontFixture, tenant: tenantFixture });
    sendMock.mockResolvedValue({ id: 'x' });

    await handleOtpRequested(tenantModeData);

    const args = sendMock.mock.calls[0]?.[0];
    if (!args) throw new Error('sendMock was not called');
    const html = await render(args.react);
    expect(html).toContain('654321');
    expect(html).toContain('OOMI Kitchen Test');
    expect(html).toContain('https://cdn.example/oomi.png'); // storefront logo
    expect(html).toContain('#16a34a'); // storefront primary color
  });

  it('falls back to DELIVERSE_PRIMARY when storefront.brandingJson has no primary', async () => {
    const minimalStorefront = { ...storefrontFixture, brandingJson: {} };
    resolveTenantMock.mockResolvedValue({ storefront: minimalStorefront, tenant: tenantFixture });
    sendMock.mockResolvedValue({ id: 'x' });

    await handleOtpRequested(tenantModeData);

    const args = sendMock.mock.calls[0]?.[0];
    if (!args) throw new Error('sendMock was not called');
    const html = await render(args.react);
    // Storefront name still renders (no logo to fall back to either).
    expect(html).toContain('OOMI Kitchen Test');
    // Doesn't contain the storefront logo since brandingJson is empty.
    expect(html).not.toContain('https://cdn.example/oomi.png');
  });

  it('propagates tenant-resolver throws (Inngest retries)', async () => {
    const boom = new Error('emails: brand resolution failed — boom (tenant)');
    resolveTenantMock.mockRejectedValue(boom);

    await expect(handleOtpRequested(tenantModeData)).rejects.toThrow(/brand resolution failed/);
    expect(sendMock).not.toHaveBeenCalled();
  });
});
