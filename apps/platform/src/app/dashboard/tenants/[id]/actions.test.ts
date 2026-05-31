/**
 * Authorization tests for the tenant Stripe/Connect server actions (DEL-46).
 *
 * Exercises `requireTenantAccess` THROUGH the two actions by mocking the session,
 * the DB reads (platform_users staff/soft-delete, tenant_memberships, payments),
 * and Stripe — no real Postgres. `redirect`/`notFound` are mocked to throw tagged
 * errors (as Next does) so we can assert which boundary fired and, crucially, that
 * no Stripe side effect ran on the deny paths.
 *
 * Relies on the `@/` alias in vitest.config.ts (vitest does not read tsconfig
 * paths). DB WHERE-clause behavior is covered end-to-end elsewhere; here the
 * mocks stage canned results to drive each authorization branch.
 */

import { type Mock, beforeEach, describe, expect, it, vi } from 'vitest';

// ---- Mocks (factories use inline vi.fn(); staged per-test via the accessors) ----

vi.mock('@/lib/auth', () => ({
  auth: { api: { getSession: vi.fn() } },
}));

vi.mock('@rp/db', () => ({
  db: {
    query: {
      platformUsers: { findFirst: vi.fn() },
      tenantMemberships: { findFirst: vi.fn() },
      payments: { findFirst: vi.fn() },
    },
  },
}));

vi.mock('@rp/payments', () => ({
  createOrReuseConnectAccount: vi.fn(),
  createAccountLink: vi.fn(),
  getStripe: vi.fn(),
}));

vi.mock('next/headers', () => ({
  headers: vi.fn(async () => new Headers()),
}));

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}));

// redirect()/notFound() terminate control flow by throwing in Next; model that
// with tagged errors so tests can distinguish the boundary that fired.
vi.mock('next/navigation', () => ({
  redirect: vi.fn((url: string) => {
    throw Object.assign(new Error('NEXT_REDIRECT'), { url });
  }),
  notFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
}));

// ---- Imports (must come AFTER vi.mock) ----

import { db } from '@rp/db';
import {
  createAccountLink,
  createOrReuseConnectAccount,
  getStripe,
} from '@rp/payments';
import { auth } from '@/lib/auth';
import { refundPaymentAction, startStripeOnboardingAction } from './actions';

// ---- Fixtures + loose mock accessors ----
// The static type of these imports is the REAL module type, so cast through
// `unknown` to a loose Mock for ergonomic `mockResolvedValue` staging.

const TENANT_ID = '11111111-1111-4111-9111-111111111111';
const PAYMENT_ID = '22222222-2222-4222-9222-222222222222';
const USER_ID = '33333333-3333-4333-9333-333333333333';
const ACCOUNT_LINK_URL = 'https://connect.stripe.com/setup/s/test';

const getSession = auth.api.getSession as unknown as Mock;
const findStaff = db.query.platformUsers.findFirst as unknown as Mock;
const findMembership = db.query.tenantMemberships.findFirst as unknown as Mock;
const findPayment = db.query.payments.findFirst as unknown as Mock;
const stripe = getStripe as unknown as Mock;
const connectAccount = createOrReuseConnectAccount as unknown as Mock;
const accountLink = createAccountLink as unknown as Mock;
const refundsCreate = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  // Defaults: authenticated, active, non-staff user; no membership; valid payment.
  getSession.mockResolvedValue({ user: { id: USER_ID } });
  findStaff.mockResolvedValue({ isPlatformStaff: false, deletedAt: null });
  findMembership.mockResolvedValue(undefined);
  findPayment.mockResolvedValue({ externalId: 'pi_123' });
  stripe.mockReturnValue({ refunds: { create: refundsCreate } });
  connectAccount.mockResolvedValue('acct_123');
  accountLink.mockResolvedValue(ACCOUNT_LINK_URL);
});

describe('startStripeOnboardingAction — authorization (DEL-46)', () => {
  it('allows platform staff (no membership lookup) → redirects to Stripe', async () => {
    findStaff.mockResolvedValue({ isPlatformStaff: true, deletedAt: null });

    await expect(startStripeOnboardingAction(TENANT_ID)).rejects.toMatchObject({
      message: 'NEXT_REDIRECT',
      url: ACCOUNT_LINK_URL,
    });
    expect(findMembership).not.toHaveBeenCalled();
    expect(connectAccount).toHaveBeenCalledWith(TENANT_ID);
  });

  it('allows a tenant owner → redirects to Stripe', async () => {
    findMembership.mockResolvedValue({ role: 'owner' });

    await expect(startStripeOnboardingAction(TENANT_ID)).rejects.toMatchObject({
      message: 'NEXT_REDIRECT',
      url: ACCOUNT_LINK_URL,
    });
    expect(connectAccount).toHaveBeenCalledWith(TENANT_ID);
  });

  it('denies a non-member with 404 before any Connect account is created', async () => {
    findMembership.mockResolvedValue(undefined);

    await expect(startStripeOnboardingAction(TENANT_ID)).rejects.toMatchObject({
      message: 'NEXT_NOT_FOUND',
    });
    expect(connectAccount).not.toHaveBeenCalled();
    expect(accountLink).not.toHaveBeenCalled();
  });

  it('redirects an unauthenticated caller to /login', async () => {
    getSession.mockResolvedValue(null);

    await expect(startStripeOnboardingAction(TENANT_ID)).rejects.toMatchObject({
      message: 'NEXT_REDIRECT',
      url: '/login',
    });
    expect(connectAccount).not.toHaveBeenCalled();
  });
});

describe('refundPaymentAction — authorization (DEL-46)', () => {
  it.each(['owner', 'manager'] as const)(
    'allows a tenant %s → issues a full-unwind refund',
    async (role) => {
      findMembership.mockResolvedValue({ role });

      await expect(refundPaymentAction(TENANT_ID, PAYMENT_ID)).resolves.toBeUndefined();
      expect(refundsCreate).toHaveBeenCalledWith({
        payment_intent: 'pi_123',
        reverse_transfer: true,
        refund_application_fee: true,
        metadata: { platform_user_id: USER_ID },
      });
    },
  );

  it('allows platform staff without a membership lookup', async () => {
    findStaff.mockResolvedValue({ isPlatformStaff: true, deletedAt: null });

    await expect(refundPaymentAction(TENANT_ID, PAYMENT_ID)).resolves.toBeUndefined();
    expect(findMembership).not.toHaveBeenCalled();
    expect(refundsCreate).toHaveBeenCalledTimes(1);
  });

  it('denies a non-member with 404 and issues no refund', async () => {
    findMembership.mockResolvedValue(undefined);

    await expect(refundPaymentAction(TENANT_ID, PAYMENT_ID)).rejects.toMatchObject({
      message: 'NEXT_NOT_FOUND',
    });
    expect(refundsCreate).not.toHaveBeenCalled();
  });

  it('denies a cross-tenant paymentId with 404 and issues no refund', async () => {
    findMembership.mockResolvedValue({ role: 'owner' }); // caller IS authorized…
    findPayment.mockResolvedValue(undefined); // …but the id is not in this tenant

    await expect(refundPaymentAction(TENANT_ID, PAYMENT_ID)).rejects.toMatchObject({
      message: 'NEXT_NOT_FOUND',
    });
    expect(refundsCreate).not.toHaveBeenCalled();
  });

  it.each(['staff', 'viewer'] as const)(
    'denies the lower-privilege per-tenant %s role (not platform staff)',
    async (role) => {
      findMembership.mockResolvedValue({ role });

      await expect(refundPaymentAction(TENANT_ID, PAYMENT_ID)).rejects.toMatchObject({
        message: 'NEXT_NOT_FOUND',
      });
      expect(refundsCreate).not.toHaveBeenCalled();
    },
  );

  it('denies a soft-deleted user with 404 before the membership check', async () => {
    // Even with the staff flag set, a soft-deleted user is rejected up-front.
    findStaff.mockResolvedValue({ isPlatformStaff: true, deletedAt: new Date('2020-01-01') });

    await expect(refundPaymentAction(TENANT_ID, PAYMENT_ID)).rejects.toMatchObject({
      message: 'NEXT_NOT_FOUND',
    });
    expect(findMembership).not.toHaveBeenCalled();
    expect(refundsCreate).not.toHaveBeenCalled();
  });
});
