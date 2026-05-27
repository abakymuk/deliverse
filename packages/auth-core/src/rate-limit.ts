/**
 * OTP rate limiting for the storefront (DEL-9 / docs/specs/otp-rate-limiting.md).
 *
 * Enforces two gates per `(tenant_id, lower(email))`:
 *
 *   1. **Request window:** at most one OTP per `OTP_REQUEST_WINDOW_SECONDS`
 *      (60s). Implemented by reading the latest `tenant_end_user_verifications`
 *      row for `type='otp_login'` and checking `last_requested_at`.
 *
 *   2. **Failure cooldown:** after `OTP_MAX_FAILURES` (5) wrong verify
 *      attempts, the (tenant, identifier) is locked for
 *      `OTP_LOCKOUT_DURATION_SECONDS` (15 min). Because BA deletes the
 *      verification row when its `allowedAttempts` is exceeded (see
 *      `node_modules/.../email-otp/routes.mjs:245-247`), the lockout state
 *      is persisted in a separate `tenant_otp_lockouts` table that survives
 *      the row delete.
 *
 * Surface: this helper is called by the wrapped storefront adapter (Path B
 * from the spec) — `verification.create` for `type='otp_login'` calls
 * `checkOtpRequest` immediately before delegating to `inner.create`;
 * `verification.update` calls `recordOtpFailure` when the parsed attempts
 * counter inside `value` (encoded by BA as `${otp_hash}:${N}`) reaches
 * `OTP_MAX_FAILURES`.
 *
 * v1 race condition: check + write are NOT atomic — BA's `DBAdapter`
 * abstraction doesn't expose its underlying connection, so we can't put
 * `inner.create` inside our `db.transaction(...)` to share a
 * `pg_advisory_xact_lock`. The window is microseconds; worst case a user
 * receives 2 OTPs instead of 1 if two requests fire simultaneously. Long-
 * term throttle still ~1 OTP/60s. Documented in spec §"BA Behavior" and
 * §"Risks".
 */

import { db } from '@rp/db';
import { tenantOtpLockouts } from '@rp/db/schema';
import { APIError } from 'better-auth';
import { and, desc, eq, gt } from 'drizzle-orm';

// Tunables. Re-exported so tests + BA config + UI countdown stay in sync.
export const OTP_MAX_FAILURES = 5;
export const OTP_REQUEST_WINDOW_SECONDS = 60;
export const OTP_LOCKOUT_DURATION_SECONDS = 15 * 60;

// Stable app-defined error codes + lockout-row reasons. The two
// constants below are aligned: every `OTP_LOCKOUT_REASONS` value has a
// matching `OTP_RATE_LIMIT_CODES` entry. checkOtpRequest reads the
// lockout row's `reason` and maps to the corresponding error code.
export const OTP_LOCKOUT_REASONS = {
  TOO_FREQUENT: 'too_frequent',
  COOLDOWN: 'cooldown',
} as const;

export type OtpLockoutReason =
  (typeof OTP_LOCKOUT_REASONS)[keyof typeof OTP_LOCKOUT_REASONS];

export const OTP_RATE_LIMIT_CODES = {
  TOO_FREQUENT: 'otp_rate_limit_too_frequent',
  COOLDOWN: 'otp_rate_limit_cooldown',
} as const;

export type OtpRateLimitCode = (typeof OTP_RATE_LIMIT_CODES)[keyof typeof OTP_RATE_LIMIT_CODES];

function codeForReason(reason: string): OtpRateLimitCode {
  return reason === OTP_LOCKOUT_REASONS.TOO_FREQUENT
    ? OTP_RATE_LIMIT_CODES.TOO_FREQUENT
    : OTP_RATE_LIMIT_CODES.COOLDOWN;
}

/**
 * Lowercase + trim. Mirrors BA's `.toLowerCase()` on incoming OTP emails
 * (node_modules/.../email-otp/routes.mjs:91); we additionally trim incidental
 * whitespace so `' john@x.com '` and `'JOHN@x.COM'` collapse to the same bucket.
 */
export function normalizeOtpEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Extract the email from a BA OTP identifier of shape `${type}-otp-${email}`.
 * Returns null if the identifier doesn't look like an OTP identifier.
 *
 * Mirrors `deriveVerificationType` prefixes. BA reference:
 *   node_modules/.../email-otp/utils.mjs:4-7  →  toOTPIdentifier(type, email)
 */
export function extractEmailFromOtpIdentifier(identifier: string): string | null {
  for (const prefix of [
    'sign-in-otp-',
    'email-verification-otp-',
    'forget-password-otp-',
  ]) {
    if (identifier.startsWith(prefix)) {
      return identifier.slice(prefix.length);
    }
  }
  return null;
}

/**
 * Parse the failed-attempts counter that BA encodes inside the `value`
 * column as `${otp_hash}:${N}`. Returns 0 for a fresh OTP or when the
 * trailing `:N` segment is missing (defensive).
 *
 * BA reference: node_modules/.../email-otp/utils.mjs:11-15 (splitAtLastColon).
 */
export function parseOtpAttemptsFromValue(value: string): number {
  const idx = value.lastIndexOf(':');
  if (idx === -1) return 0;
  const tail = value.slice(idx + 1);
  const n = Number.parseInt(tail, 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function throwTooFrequent(retryAfterSeconds: number): never {
  throw new APIError('BAD_REQUEST', {
    message: `OTP requested too frequently. Try again in ${retryAfterSeconds}s.`,
    code: OTP_RATE_LIMIT_CODES.TOO_FREQUENT,
    retryAfterSeconds,
  });
}

function throwCooldown(retryAfterSeconds: number): never {
  throw new APIError('BAD_REQUEST', {
    message: `OTP locked for ${retryAfterSeconds}s after too many failed attempts.`,
    code: OTP_RATE_LIMIT_CODES.COOLDOWN,
    retryAfterSeconds,
  });
}

/**
 * Throws `APIError('BAD_REQUEST', { code })` when the (tenantId, normalized
 * email) is rate-limited; returns clean when allowed.
 *
 * Order matters: cooldown is checked first because it's the longer window
 * and the more important security signal. If the cooldown is active, we
 * don't bother checking the 60s window — the lockout outranks it.
 *
 * v1: NOT atomic against concurrent callers. See module-level comment
 * + spec §"BA Behavior" for the race-condition trade-off.
 */
export async function checkOtpRequest(params: {
  tenantId: string;
  email: string;
}): Promise<void> {
  const normalizedEmail = normalizeOtpEmail(params.email);
  const nowMs = Date.now();
  const now = new Date(nowMs);

  // Both gates resolve to a `tenant_otp_lockouts` row — the table is the
  // source of truth for "is this (tenant, email) currently rate-limited?".
  // The 60s window's row is stamped post-create in the wrapped adapter
  // (reason='too_frequent', expires_at = now + 60s). The 15min cooldown
  // is stamped by `recordOtpFailure` (reason='cooldown', expires_at =
  // now + 15min). Why unified: BA's resolveOTP catches verification-row
  // create errors and retries via delete+recreate (routes.mjs:43-49),
  // so any rate-limit signal stored ON the verification row gets wiped
  // by the retry. Storing it here, in a table BA doesn't know about,
  // survives the retry.
  const [latestLockout] = await db
    .select({
      expiresAt: tenantOtpLockouts.expiresAt,
      reason: tenantOtpLockouts.reason,
    })
    .from(tenantOtpLockouts)
    .where(
      and(
        eq(tenantOtpLockouts.tenantId, params.tenantId),
        eq(tenantOtpLockouts.identifier, normalizedEmail),
        gt(tenantOtpLockouts.expiresAt, now),
      ),
    )
    .orderBy(desc(tenantOtpLockouts.expiresAt))
    .limit(1);

  if (latestLockout) {
    const retryAfter = Math.max(
      1,
      Math.ceil((latestLockout.expiresAt.getTime() - nowMs) / 1000),
    );
    const code = codeForReason(latestLockout.reason);
    if (code === OTP_RATE_LIMIT_CODES.TOO_FREQUENT) {
      throwTooFrequent(retryAfter);
    }
    throwCooldown(retryAfter);
  }
}

/**
 * INSERTs a `tenant_otp_lockouts` row valid for `OTP_LOCKOUT_DURATION_SECONDS`.
 * Called by the wrapped storefront adapter when it detects on
 * `verification.update` that `parseOtpAttemptsFromValue(newValue)` has crossed
 * `OTP_MAX_FAILURES`, BEFORE BA's subsequent `deleteVerificationByIdentifier`
 * wipes the row (node_modules/.../email-otp/routes.mjs:245-247).
 *
 * Idempotent-ish: a duplicate insert is harmless — `checkOtpRequest` picks the
 * latest unexpired row. We deliberately do NOT dedup or UPSERT to keep the
 * write simple and fast.
 *
 * Failures here MUST NOT block BA's flow — the caller should log + Sentry
 * but propagate BA's response so the user still sees the TOO_MANY_ATTEMPTS
 * error. The trade-off: the very next OTP request may not be locked if this
 * write failed. Accepted v1 limitation per spec §Edge Cases #8.
 */
export async function recordOtpFailure(params: {
  tenantId: string;
  /** Already-normalized email — caller responsible for normalization. */
  identifier: string;
}): Promise<void> {
  const expiresAt = new Date(Date.now() + OTP_LOCKOUT_DURATION_SECONDS * 1000);
  await db.insert(tenantOtpLockouts).values({
    tenantId: params.tenantId,
    identifier: params.identifier,
    expiresAt,
    reason: OTP_LOCKOUT_REASONS.COOLDOWN,
  });
}

/**
 * Stamps the 60s "too_frequent" lockout. Called by the wrapped storefront
 * adapter AFTER a successful OTP-create so subsequent requests within
 * `OTP_REQUEST_WINDOW_SECONDS` for the same (tenant, identifier) are
 * rejected via checkOtpRequest.
 *
 * Stored in `tenant_otp_lockouts` (NOT on the verification row's
 * last_requested_at) because BA's resolveOTP catches create errors and
 * retries via delete+recreate, wiping any verification-row-bound signal.
 * See spec §"BA Behavior".
 *
 * Failures are non-blocking — caller logs and continues.
 */
export async function recordOtpThrottle(params: {
  tenantId: string;
  /** Already-normalized email — caller responsible for normalization. */
  identifier: string;
}): Promise<void> {
  const expiresAt = new Date(Date.now() + OTP_REQUEST_WINDOW_SECONDS * 1000);
  await db.insert(tenantOtpLockouts).values({
    tenantId: params.tenantId,
    identifier: params.identifier,
    expiresAt,
    reason: OTP_LOCKOUT_REASONS.TOO_FREQUENT,
  });
}
