/**
 * Unit tests for `rate-limit.ts` (DEL-9 / docs/specs/otp-rate-limiting.md).
 *
 * Approach: mock `@rp/db` so we can stage canned `SELECT` results for the
 * lockout + verification lookups without standing up a real Postgres for
 * each test. Matches the existing pattern in `storefront-adapter.test.ts`
 * (mock-based, no DB). E2E coverage in
 * `apps/storefront/tests/e2e/otp-rate-limit.spec.ts` exercises the real DB
 * paths end-to-end.
 *
 * Six cases per the DEL-9 spec §1.4:
 *   1. no prior verification row → checkOtpRequest returns clean
 *   2. latest row last_requested_at < 60s ago → throws too_frequent
 *   3. latest row > 60s ago, no lockout → returns clean
 *   4. unexpired lockout row → throws cooldown
 *   5. tenant isolation — independent buckets
 *   6. email normalization (case + whitespace)
 */

import { APIError } from 'better-auth';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---- Mock @rp/db --------------------------------------------------------

// checkOtpRequest now performs a single SELECT against tenant_otp_lockouts.
// `stageNextLockout` controls what the next SELECT returns, regardless of
// WHERE clause (the WHERE behavior is exercised by the E2E suite against
// a real Postgres).

type LockoutRow = { expiresAt: Date; reason: string };
let nextLockoutRows: LockoutRow[] = [];

type InsertArgs = {
  tenantId: string;
  identifier: string;
  expiresAt: Date;
  reason?: string;
};
const insertSpy = vi.fn(async (_args: InsertArgs): Promise<undefined> => undefined);

vi.mock('@rp/db', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            limit: () => {
              const rows = nextLockoutRows;
              nextLockoutRows = [];
              return Promise.resolve(rows);
            },
          }),
        }),
      }),
    }),
    insert: () => ({
      values: insertSpy,
    }),
  },
}));

function stageNextLockout(rows: LockoutRow[]) {
  nextLockoutRows = rows;
}

beforeEach(() => {
  nextLockoutRows = [];
  insertSpy.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

// ---- Imports (must come AFTER vi.mock) ---------------------------------

import {
  OTP_LOCKOUT_DURATION_SECONDS,
  OTP_LOCKOUT_REASONS,
  OTP_MAX_FAILURES,
  OTP_RATE_LIMIT_CODES,
  OTP_REQUEST_WINDOW_SECONDS,
  checkOtpRequest,
  extractEmailFromOtpIdentifier,
  normalizeOtpEmail,
  parseOtpAttemptsFromValue,
  recordOtpFailure,
  recordOtpThrottle,
} from './rate-limit';

const TENANT_A = '11111111-1111-4111-9111-111111111111';
const TENANT_B = '22222222-2222-4222-9222-222222222222';

// ---- Pure helpers -------------------------------------------------------

describe('normalizeOtpEmail', () => {
  it('lowercases', () => {
    expect(normalizeOtpEmail('JOHN@x.COM')).toBe('john@x.com');
  });

  it('trims surrounding whitespace', () => {
    expect(normalizeOtpEmail('  john@x.com  ')).toBe('john@x.com');
  });

  it('handles mixed case + whitespace together', () => {
    expect(normalizeOtpEmail(' JOHN@X.com ')).toBe('john@x.com');
  });
});

describe('extractEmailFromOtpIdentifier', () => {
  it('extracts from sign-in-otp- prefix', () => {
    expect(extractEmailFromOtpIdentifier('sign-in-otp-john@x.com')).toBe('john@x.com');
  });

  it('extracts from email-verification-otp- prefix', () => {
    expect(extractEmailFromOtpIdentifier('email-verification-otp-a@b.co')).toBe('a@b.co');
  });

  it('extracts from forget-password-otp- prefix', () => {
    expect(extractEmailFromOtpIdentifier('forget-password-otp-a@b.co')).toBe('a@b.co');
  });

  it('handles emails with hyphens', () => {
    expect(extractEmailFromOtpIdentifier('sign-in-otp-first-name@x.com')).toBe(
      'first-name@x.com',
    );
  });

  it('returns null for unknown shapes', () => {
    expect(extractEmailFromOtpIdentifier('reset-password:abc')).toBeNull();
    expect(extractEmailFromOtpIdentifier('just-some-string')).toBeNull();
    expect(extractEmailFromOtpIdentifier('')).toBeNull();
  });
});

describe('parseOtpAttemptsFromValue', () => {
  it('parses :N suffix', () => {
    expect(parseOtpAttemptsFromValue('abc123:0')).toBe(0);
    expect(parseOtpAttemptsFromValue('abc123:3')).toBe(3);
    expect(parseOtpAttemptsFromValue('abc123:5')).toBe(5);
  });

  it('returns 0 for missing colon (defensive)', () => {
    expect(parseOtpAttemptsFromValue('justthehash')).toBe(0);
  });

  it('returns 0 for non-numeric tail', () => {
    expect(parseOtpAttemptsFromValue('abc:NaN')).toBe(0);
    expect(parseOtpAttemptsFromValue('abc:')).toBe(0);
  });

  it('handles hash with multiple colons by splitting at last', () => {
    // Hashes themselves don't contain `:`, but defensive.
    expect(parseOtpAttemptsFromValue('a:b:c:7')).toBe(7);
  });
});

// ---- DEL-9 spec §1.4 — six cases ---------------------------------------

describe('checkOtpRequest — 6 cases', () => {
  it('case 1: no lockout row → returns clean', async () => {
    stageNextLockout([]);
    await expect(checkOtpRequest({ tenantId: TENANT_A, email: 'a@x.com' })).resolves.toBeUndefined();
  });

  it('case 2: unexpired too_frequent lockout → throws otp_rate_limit_too_frequent', async () => {
    const expiresAt = new Date(Date.now() + 30_000); // 30s from now
    stageNextLockout([{ expiresAt, reason: OTP_LOCKOUT_REASONS.TOO_FREQUENT }]);

    await expect(
      checkOtpRequest({ tenantId: TENANT_A, email: 'a@x.com' }),
    ).rejects.toMatchObject({
      body: expect.objectContaining({
        code: OTP_RATE_LIMIT_CODES.TOO_FREQUENT,
        retryAfterSeconds: expect.any(Number),
      }),
    });
  });

  it('case 3: no unexpired lockout → returns clean (the DB query filters expired)', async () => {
    // The real DB query uses `gt(expires_at, now())`, so expired rows never
    // come back. The mock just returns whatever we stage; staging an empty
    // array mirrors the DB filter result.
    stageNextLockout([]);
    await expect(checkOtpRequest({ tenantId: TENANT_A, email: 'a@x.com' })).resolves.toBeUndefined();
  });

  it('case 4: unexpired cooldown lockout → throws otp_rate_limit_cooldown', async () => {
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 min from now
    stageNextLockout([{ expiresAt, reason: OTP_LOCKOUT_REASONS.COOLDOWN }]);

    await expect(
      checkOtpRequest({ tenantId: TENANT_A, email: 'a@x.com' }),
    ).rejects.toMatchObject({
      body: expect.objectContaining({
        code: OTP_RATE_LIMIT_CODES.COOLDOWN,
        retryAfterSeconds: expect.any(Number),
      }),
    });
  });

  it('case 5: tenant isolation — tenant A lockout does NOT affect tenant B', async () => {
    // tenant A: under lockout. Throws.
    stageNextLockout([
      {
        expiresAt: new Date(Date.now() + 60_000),
        reason: OTP_LOCKOUT_REASONS.TOO_FREQUENT,
      },
    ]);
    await expect(
      checkOtpRequest({ tenantId: TENANT_A, email: 'shared@x.com' }),
    ).rejects.toThrow(APIError);

    // tenant B (different tenant_id): the real DB query filters by
    // tenant_id, so it sees its own clean state. With the call-by-call
    // mock we stage an empty result to mirror that filter behavior.
    stageNextLockout([]);
    await expect(
      checkOtpRequest({ tenantId: TENANT_B, email: 'shared@x.com' }),
    ).resolves.toBeUndefined();
  });

  it('case 6: email normalization — JOHN@X.COM and " john@x.com " resolve to the same bucket', async () => {
    // First call: with uppercase + whitespace → should normalize and (with
    // no staged lockout) succeed.
    stageNextLockout([]);
    await expect(
      checkOtpRequest({ tenantId: TENANT_A, email: '  JOHN@x.COM  ' }),
    ).resolves.toBeUndefined();

    // Second call: same normalized email, with a recent lockout → rejected.
    // The mock doesn't inspect the WHERE clause; this case primarily proves
    // the helper doesn't throw on case/whitespace variation. Real bucket
    // equivalence is enforced by `normalizeOtpEmail` (tested above) and
    // verified end-to-end by the E2E suite against a real Postgres.
    stageNextLockout([
      {
        expiresAt: new Date(Date.now() + 30_000),
        reason: OTP_LOCKOUT_REASONS.TOO_FREQUENT,
      },
    ]);
    await expect(
      checkOtpRequest({ tenantId: TENANT_A, email: 'john@x.com' }),
    ).rejects.toMatchObject({
      body: expect.objectContaining({ code: OTP_RATE_LIMIT_CODES.TOO_FREQUENT }),
    });
  });
});

describe('recordOtpFailure', () => {
  it('inserts a cooldown lockout row with expires_at = now + 15min', async () => {
    const before = Date.now();
    await recordOtpFailure({ tenantId: TENANT_A, identifier: 'a@x.com' });

    expect(insertSpy).toHaveBeenCalledTimes(1);
    const inserted = insertSpy.mock.calls[0]?.[0];
    if (!inserted) throw new Error('insertSpy never called');
    expect(inserted.tenantId).toBe(TENANT_A);
    expect(inserted.identifier).toBe('a@x.com');
    expect(inserted.reason).toBe(OTP_LOCKOUT_REASONS.COOLDOWN);
    const expectedEnd = before + OTP_LOCKOUT_DURATION_SECONDS * 1000;
    expect(inserted.expiresAt.getTime()).toBeGreaterThanOrEqual(expectedEnd - 1000);
    expect(inserted.expiresAt.getTime()).toBeLessThanOrEqual(expectedEnd + 1000);
  });
});

describe('recordOtpThrottle', () => {
  it('inserts a too_frequent lockout row with expires_at = now + 60s', async () => {
    const before = Date.now();
    await recordOtpThrottle({ tenantId: TENANT_A, identifier: 'a@x.com' });

    expect(insertSpy).toHaveBeenCalledTimes(1);
    const inserted = insertSpy.mock.calls[0]?.[0];
    if (!inserted) throw new Error('insertSpy never called');
    expect(inserted.tenantId).toBe(TENANT_A);
    expect(inserted.identifier).toBe('a@x.com');
    expect(inserted.reason).toBe(OTP_LOCKOUT_REASONS.TOO_FREQUENT);
    const expectedEnd = before + OTP_REQUEST_WINDOW_SECONDS * 1000;
    expect(inserted.expiresAt.getTime()).toBeGreaterThanOrEqual(expectedEnd - 1000);
    expect(inserted.expiresAt.getTime()).toBeLessThanOrEqual(expectedEnd + 1000);
  });
});

describe('constants', () => {
  it('exports the values DEL-9 spec mandates', () => {
    expect(OTP_MAX_FAILURES).toBe(5);
    expect(OTP_REQUEST_WINDOW_SECONDS).toBe(60);
    expect(OTP_LOCKOUT_DURATION_SECONDS).toBe(15 * 60);
    expect(OTP_RATE_LIMIT_CODES.TOO_FREQUENT).toBe('otp_rate_limit_too_frequent');
    expect(OTP_RATE_LIMIT_CODES.COOLDOWN).toBe('otp_rate_limit_cooldown');
  });
});
