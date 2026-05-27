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
  resolveTenantStorefrontEmailContext: vi.fn(),
  BrandResolutionError: class BrandResolutionError extends Error {},
}));

vi.mock('../src/client', () => ({
  sendEmail: vi.fn(),
  EmailSendError: class EmailSendError extends Error {},
}));

const { handlePasswordResetRequested } = await import('../src/handlers/password-reset-requested');
const { resolveEmailBrandContext, resolveTenantStorefrontEmailContext } = await import(
  '../src/brand-context'
);
const { sendEmail } = await import('../src/client');

const resolveMock = vi.mocked(resolveEmailBrandContext);
const resolveTenantMock = vi.mocked(resolveTenantStorefrontEmailContext);
const sendMock = vi.mocked(sendEmail);

const TENANT_ID = '11111111-1111-4111-9111-111111111111';
const USER_ID = '33333333-3333-4333-9333-333333333333';
const BRAND_ID = '22222222-2222-4222-9222-222222222222';
const STOREFRONT_ID = '44444444-4444-4444-9444-444444444444';

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
  resolveTenantMock.mockReset();
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

// ── DEL-22 tenant-mode storefront variant ─────────────────────────────────

describe('handlePasswordResetRequested — tenant mode (DEL-22)', () => {
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

  const TENANT_RESET_URL = 'https://oomi-kitchen-test.deliverse.app/reset-password?token=abc';

  const tenantData: PasswordResetRequestedData = {
    instance: 'storefront',
    email: 'jane@example.com',
    userId: USER_ID,
    url: TENANT_RESET_URL,
    mode: 'tenant',
    tenantId: TENANT_ID,
    storefrontId: STOREFRONT_ID,
    storefrontSlug: 'oomi-kitchen-test',
  };

  it('resolves storefront (not brand) context and renders with storefront name subject', async () => {
    resolveTenantMock.mockResolvedValue({ storefront: storefrontFixture, tenant: tenantFixture });
    sendMock.mockResolvedValue({ id: 'resend-tenant-id' });

    const result = await handlePasswordResetRequested(tenantData);

    expect(result).toEqual({ id: 'resend-tenant-id' });
    expect(resolveTenantMock).toHaveBeenCalledWith(STOREFRONT_ID, TENANT_ID);
    expect(resolveMock).not.toHaveBeenCalled(); // brand resolver MUST NOT fire in tenant mode

    const args = sendMock.mock.calls[0]?.[0];
    expect(args?.subject).toBe('Reset your password for OOMI Kitchen Test');
  });

  it('rendered template uses storefront branding (logo + primary color from storefront.brandingJson)', async () => {
    resolveTenantMock.mockResolvedValue({ storefront: storefrontFixture, tenant: tenantFixture });
    sendMock.mockResolvedValue({ id: 'x' });

    await handlePasswordResetRequested(tenantData);

    const args = sendMock.mock.calls[0]?.[0];
    if (!args) throw new Error('sendMock was not called');
    const html = await render(args.react);
    expect(html).toContain('OOMI Kitchen Test');
    expect(html).toContain(TENANT_RESET_URL);
    expect(html).toContain('https://cdn.example/oomi.png');
    expect(html).toContain('#16a34a');
  });

  it('falls back through storefront.brandingJson → tenant.logo → DELIVERSE_PRIMARY', async () => {
    // No storefront branding; tenant has a logo to fall back to.
    const minimalStorefront = { ...storefrontFixture, brandingJson: {} };
    const tenantWithLogo = { ...tenantFixture, logo: 'https://cdn.example/tenant.png' };
    resolveTenantMock.mockResolvedValue({ storefront: minimalStorefront, tenant: tenantWithLogo });
    sendMock.mockResolvedValue({ id: 'x' });

    await handlePasswordResetRequested(tenantData);

    const args = sendMock.mock.calls[0]?.[0];
    if (!args) throw new Error('sendMock was not called');
    const html = await render(args.react);
    expect(html).toContain('https://cdn.example/tenant.png'); // tenant logo fallback
  });

  it('propagates tenant-resolver throws (Inngest retries)', async () => {
    resolveTenantMock.mockRejectedValue(new Error('emails: brand resolution failed — boom (tenant)'));
    await expect(handlePasswordResetRequested(tenantData)).rejects.toThrow(/brand resolution/);
    expect(sendMock).not.toHaveBeenCalled();
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
