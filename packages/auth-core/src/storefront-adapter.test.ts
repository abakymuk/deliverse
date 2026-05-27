/**
 * Unit tests for `wrappedStorefrontAdapter` — the account-scoping additions
 * shipped by DEL-12 + regression coverage of the user/verification/session
 * behavior DEL-3 originally established.
 *
 * Mocks the inner `DBAdapter` so we assert outgoing data + where shapes
 * without touching Drizzle or the DB.
 *
 * LAYERING NOTE: these wrapper tests CANNOT catch a missing
 * `account.additionalFields.tenantId` registration in the storefront BA
 * config (`packages/auth-core/src/storefront.ts`). The inner adapter is
 * mocked, so the field flows through regardless of BA's schema awareness.
 * The BA-config layer is verified separately by the Path A staging smoke
 * (signup → SELECT tenant_id post-write). See docs/specs/del-12-account-tenant-scoping.md.
 */

import type { DBAdapter } from 'better-auth';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Stub @rp/db so the eager `DATABASE_URL` check in `packages/db/src/client.ts`
// doesn't run during this mock-only test suite. The wrapped adapter pulls in
// `./rate-limit` (DEL-9), which imports `db` + `tenantOtpLockouts` from
// `@rp/db`; without this mock, importing the adapter fails at module-load
// time in CI (no Doppler env). The tests below do NOT exercise the
// verification.otp_login path, so the mock can be a no-op — none of these
// fields are read.
vi.mock('@rp/db', () => ({
  db: {},
  tenantOtpLockouts: {},
}));

import type { ResolveTenantContext, StorefrontTenantContext } from './storefront-adapter';
import { wrappedStorefrontAdapter } from './storefront-adapter';

const TENANT_ID = '11111111-1111-4111-9111-111111111111';
const BRAND_ID = '22222222-2222-4222-9222-222222222222';
const BRAND_SLUG = 'pizza-express';
const STOREFRONT_ID = '33333333-3333-4333-9333-333333333333';

const CONTEXT: StorefrontTenantContext = {
  tenantId: TENANT_ID,
  storefrontId: STOREFRONT_ID,
  storefrontType: 'brand',
  storefrontSlug: BRAND_SLUG, // brand-mode: storefront slug equals brand slug per DEL-19 backfill
  brandId: BRAND_ID,
  brandSlug: BRAND_SLUG,
};

/**
 * Minimal mock of BA's `DBAdapter`. Each method records its arguments via
 * `vi.fn` with explicit parameter annotations so `mock.calls[i]?.[0]` is
 * typed (without annotations, vitest infers `() => ...` and the calls tuple
 * collapses to `[]`).
 */
type MockArgs = {
  model?: string;
  where?: unknown[];
  data?: Record<string, unknown>;
  update?: Record<string, unknown>;
  select?: unknown;
  join?: unknown;
  forceAllowId?: boolean;
  limit?: number;
  sortBy?: unknown;
  offset?: number;
};

function makeInner() {
  return {
    id: 'mock',
    create: vi.fn(async (args: MockArgs) => ({
      id: 'created',
      ...(args.data ?? {}),
    })),
    findOne: vi.fn(async (_args: MockArgs) => null),
    findMany: vi.fn(async (_args: MockArgs) => [] as unknown[]),
    count: vi.fn(async (_args: MockArgs) => 0),
    update: vi.fn(async (_args: MockArgs) => null),
    updateMany: vi.fn(async (_args: MockArgs) => 0),
    delete: vi.fn(async (_args: MockArgs) => {}),
    deleteMany: vi.fn(async (_args: MockArgs) => 0),
    consumeOne: vi.fn(async (_args: MockArgs) => null),
    transaction: vi.fn(async (cb: (trx: DBAdapter) => Promise<unknown>) =>
      cb(makeInner() as unknown as DBAdapter),
    ),
    createSchema: vi.fn(),
    options: {},
  };
}

function resolver(): ResolveTenantContext {
  return vi.fn(async () => CONTEXT);
}

function tenantPredicate() {
  return {
    field: 'tenantId',
    value: TENANT_ID,
    operator: 'eq' as const,
    connector: 'AND' as const,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('wrappedStorefrontAdapter — account create (DEL-12)', () => {
  it('stamps tenantId on account.create from the resolver', async () => {
    const inner = makeInner();
    const wrapped = wrappedStorefrontAdapter(inner as unknown as DBAdapter, resolver());

    await wrapped.create({
      model: 'account',
      data: { providerId: 'google', accountId: 'google-uid-xyz', tenantEndUserId: 'u-1' },
    });

    expect(inner.create).toHaveBeenCalledTimes(1);
    expect(inner.create.mock.calls[0]?.[0]).toMatchObject({
      model: 'account',
      data: {
        providerId: 'google',
        accountId: 'google-uid-xyz',
        tenantEndUserId: 'u-1',
        tenantId: TENANT_ID, // ← injected
      },
    });
  });
});

describe('wrappedStorefrontAdapter — account lookups + mutations (DEL-12)', () => {
  it('appends tenantId predicate to findOne for account', async () => {
    const inner = makeInner();
    const wrapped = wrappedStorefrontAdapter(inner as unknown as DBAdapter, resolver());

    await wrapped.findOne({
      model: 'account',
      where: [
        { field: 'accountId', value: 'google-uid-xyz', operator: 'eq', connector: 'AND' },
        { field: 'providerId', value: 'google', operator: 'eq', connector: 'AND' },
      ],
    });

    expect(inner.findOne).toHaveBeenCalledTimes(1);
    expect(inner.findOne.mock.calls[0]?.[0]?.where).toEqual([
      { field: 'accountId', value: 'google-uid-xyz', operator: 'eq', connector: 'AND' },
      { field: 'providerId', value: 'google', operator: 'eq', connector: 'AND' },
      tenantPredicate(),
    ]);
  });

  it('appends tenantId predicate to findMany for account', async () => {
    const inner = makeInner();
    const wrapped = wrappedStorefrontAdapter(inner as unknown as DBAdapter, resolver());

    await wrapped.findMany({ model: 'account', where: [] });

    expect(inner.findMany.mock.calls[0]?.[0]?.where).toEqual([tenantPredicate()]);
  });

  it('appends tenantId predicate to update / updateMany / delete / deleteMany', async () => {
    const inner = makeInner();
    const wrapped = wrappedStorefrontAdapter(inner as unknown as DBAdapter, resolver());

    await wrapped.update({
      model: 'account',
      where: [{ field: 'id', value: 'a-1', operator: 'eq', connector: 'AND' }],
      update: { scope: 'profile' },
    });
    await wrapped.updateMany({
      model: 'account',
      where: [],
      update: { scope: 'profile' },
    });
    await wrapped.delete({
      model: 'account',
      where: [{ field: 'id', value: 'a-1', operator: 'eq', connector: 'AND' }],
    });
    await wrapped.deleteMany({ model: 'account', where: [] });

    for (const fn of [inner.update, inner.updateMany, inner.delete, inner.deleteMany]) {
      expect(fn).toHaveBeenCalledTimes(1);
      const where = fn.mock.calls[0]?.[0]?.where as unknown[];
      expect(where).toContainEqual(tenantPredicate());
    }
  });
});

describe('wrappedStorefrontAdapter — non-account models unchanged (regression)', () => {
  it('session.create stamps currentBrandId but NOT tenantId (sessions intentionally unscoped)', async () => {
    const inner = makeInner();
    const wrapped = wrappedStorefrontAdapter(inner as unknown as DBAdapter, resolver());

    await wrapped.create({
      model: 'session',
      data: { token: 'sess-1', tenantEndUserId: 'u-1' },
    });

    const call = inner.create.mock.calls[0]?.[0]?.data as Record<string, unknown>;
    expect(call?.currentBrandId).toBe(BRAND_ID);
    expect(call?.tenantId).toBeUndefined();
  });

  it('session.create stamps currentBrandId NULL for tenant-mode sessions (DEL-21)', async () => {
    const inner = makeInner();
    // Tenant-mode resolver: no brandId/brandSlug keys. Post-DEL-22 the BA
    // resolver returns this shape for tenant-host requests; the adapter
    // stamps NULL for currentBrandId via the explicit `?? null`.
    const tenantModeResolver: ResolveTenantContext = vi.fn(async () => ({
      tenantId: TENANT_ID,
      storefrontId: STOREFRONT_ID,
      storefrontType: 'tenant' as const,
      storefrontSlug: 'oomi-kitchen-test',
    }));
    const wrapped = wrappedStorefrontAdapter(inner as unknown as DBAdapter, tenantModeResolver);

    await wrapped.create({
      model: 'session',
      data: { token: 'sess-tenant', tenantEndUserId: 'u-1' },
    });

    const call = inner.create.mock.calls[0]?.[0]?.data as Record<string, unknown>;
    // Explicit `.toBe(null)` — guards against a future "cleanup" that
    // replaces the explicit `?? null` with a conditional spread, which would
    // silently regress the tenant-mode invariant.
    expect(call?.currentBrandId).toBe(null);
    expect(call?.tenantId).toBeUndefined();
  });

  it('verification.create stamps brandId NULL for tenant-mode (DEL-22)', async () => {
    const inner = makeInner();
    const tenantModeResolver: ResolveTenantContext = vi.fn(async () => ({
      tenantId: TENANT_ID,
      storefrontId: STOREFRONT_ID,
      storefrontType: 'tenant' as const,
      storefrontSlug: 'oomi-kitchen-test',
    }));
    const wrapped = wrappedStorefrontAdapter(inner as unknown as DBAdapter, tenantModeResolver);

    // Use an email-verify identifier (not 'sign-in-otp-...') so the rate-limit
    // branch (DEL-9, only fires for type='otp_login') doesn't kick in and hit
    // the unmocked `db.select(tenantOtpLockouts)` chain. The verification
    // adapter's brandId-stamping behavior is the same for all types.
    await wrapped.create({
      model: 'verification',
      data: {
        identifier: 'email-verification-otp-jane@example.com',
        value: '$2b$12$hashedotp',
        expiresAt: new Date(),
      },
    });

    const call = inner.create.mock.calls[0]?.[0]?.data as Record<string, unknown>;
    // DEL-22: `brandId: ctx.brandId ?? null` — tenant-mode rows write NULL.
    // tenantId is still stamped (security boundary unchanged).
    expect(call?.brandId).toBe(null);
    expect(call?.tenantId).toBe(TENANT_ID);
  });

  it('account.create with tenant-mode context stamps tenantId only (no brand leakage)', async () => {
    const inner = makeInner();
    const tenantModeResolver: ResolveTenantContext = vi.fn(async () => ({
      tenantId: TENANT_ID,
      storefrontId: STOREFRONT_ID,
      storefrontType: 'tenant' as const,
      storefrontSlug: 'oomi-kitchen-test',
    }));
    const wrapped = wrappedStorefrontAdapter(inner as unknown as DBAdapter, tenantModeResolver);

    await wrapped.create({
      model: 'account',
      data: { providerId: 'credential', accountId: 'cred-1', tenantEndUserId: 'u-1' },
    });

    const data = inner.create.mock.calls[0]?.[0]?.data as Record<string, unknown>;
    expect(data?.tenantId).toBe(TENANT_ID);
    expect(data?.brandId).toBeUndefined();
    expect(data?.currentBrandId).toBeUndefined();
  });

  it('session.findOne (by token) does NOT get a tenantId predicate', async () => {
    const inner = makeInner();
    const wrapped = wrappedStorefrontAdapter(inner as unknown as DBAdapter, resolver());

    await wrapped.findOne({
      model: 'session',
      where: [{ field: 'token', value: 'sess-1', operator: 'eq', connector: 'AND' }],
    });

    expect(inner.findOne.mock.calls[0]?.[0]?.where).toEqual([
      { field: 'token', value: 'sess-1', operator: 'eq', connector: 'AND' },
    ]);
  });

  it('user.create stamps tenantId (regression: DEL-3 behavior preserved)', async () => {
    const inner = makeInner();
    const wrapped = wrappedStorefrontAdapter(inner as unknown as DBAdapter, resolver());

    await wrapped.create({
      model: 'user',
      data: { email: 'guest@example.com' },
    });

    expect(inner.create.mock.calls[0]?.[0]?.data).toMatchObject({
      email: 'guest@example.com',
      tenantId: TENANT_ID,
    });
  });

  it('user.findOne gets tenantId predicate (regression)', async () => {
    const inner = makeInner();
    const wrapped = wrappedStorefrontAdapter(inner as unknown as DBAdapter, resolver());

    await wrapped.findOne({
      model: 'user',
      where: [{ field: 'email', value: 'g@example.com', operator: 'eq', connector: 'AND' }],
    });

    expect(inner.findOne.mock.calls[0]?.[0]?.where).toContainEqual(tenantPredicate());
  });
});

describe('wrappedStorefrontAdapter — resolver failure propagation', () => {
  it('account.create propagates resolver throws', async () => {
    const inner = makeInner();
    const failing: ResolveTenantContext = vi.fn(async () => {
      throw new Error('tenant context unavailable');
    });
    const wrapped = wrappedStorefrontAdapter(inner as unknown as DBAdapter, failing);

    await expect(
      wrapped.create({
        model: 'account',
        data: { providerId: 'google', accountId: 'x' },
      }),
    ).rejects.toThrow('tenant context unavailable');

    expect(inner.create).not.toHaveBeenCalled();
  });

  it('account.findOne propagates resolver throws', async () => {
    const inner = makeInner();
    const failing: ResolveTenantContext = vi.fn(async () => {
      throw new Error('tenant context unavailable');
    });
    const wrapped = wrappedStorefrontAdapter(inner as unknown as DBAdapter, failing);

    await expect(
      wrapped.findOne({
        model: 'account',
        where: [{ field: 'accountId', value: 'x', operator: 'eq', connector: 'AND' }],
      }),
    ).rejects.toThrow('tenant context unavailable');

    expect(inner.findOne).not.toHaveBeenCalled();
  });
});
