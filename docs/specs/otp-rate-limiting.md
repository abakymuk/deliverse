# OTP rate limiting (DB-backed v1) — Spec v1

**Created:** 2026-05-27
**Status:** Draft
**Owner:** Vlad
**Issue:** [DEL-9](https://linear.app/oveglobal/issue/DEL-9)
**Closes:** auth-spec [§6 AC#8](../auth-spec.md), §11.8, §11.11
**Builds on:** [ADR-0010](../decisions/0010-tenant-scoping-injection.md) (wrapped adapter), [ADR-0003](../decisions/0003-tenant-scoped-end-users.md) (tenant-scoped identity), [`docs/specs/storefront-tenant-scoping.md`](./storefront-tenant-scoping.md)

---

## Problem

Auth-spec §6 AC#8 specifies "1 OTP request per 60s per (tenant, email); 5 failed attempts → 15min cooldown". Today the storefront BA has no request-side throttle, and `allowedAttempts` is not configured — BA defaults to 3 (per `node_modules/better-auth/dist/plugins/email-otp/routes.mjs:244,785`) but even that doesn't satisfy §6 AC#8 because BA's only consequence of hitting the limit is to **delete the verification row** (`routes.mjs:245-247`) — no time-bounded lockout. A determined attacker can keep requesting new OTPs and trying again, bounded only by the per-attempt latency. This is a security baseline gap before any private beta.

## Users

- **Restaurant guests / end users** — protected from brute-force OTP attempts (5 wrong codes → 15min lockout) and from accidental rapid-request loops (1 OTP per 60s).
- **Tenants** — get a per-(tenant, email) limit, scoped by ADR-0003's tenant-scoped identity boundary.
- **Operators** — no UI in v1; observability via DB queries on the new table.

## Acceptance Criteria

1. **AC#1 (spec):** this spec is written, reviewed, and linked from [DEL-9](https://linear.app/oveglobal/issue/DEL-9).
2. Migration adds `tenant_end_user_verifications.last_requested_at TIMESTAMPTZ NOT NULL DEFAULT now()` + a rate-limit index, and a new `tenant_otp_lockouts` table (see §Data Model).
3. `packages/auth-core/src/rate-limit.ts` exports `checkOtpRequest({ tenantId, email })`, `recordOtpFailure({ verificationId })`, plus stable error codes.
4. **Request-side gate:** the storefront BA's wrapped adapter rejects a new OTP write with a typed `APIError('BAD_REQUEST', code: 'otp_rate_limit_too_frequent' | 'otp_rate_limit_cooldown')` when (a) the latest verification row for `(tenant_id, lower(email), type='otp_login')` has `last_requested_at` < 60s ago, or (b) an unexpired lockout row exists in `tenant_otp_lockouts`.
5. **Verify-side counter:** BA `emailOTP({ allowedAttempts: 5 })` is set, so BA increments its internal counter and rejects the 6th attempt with `TOO_MANY_ATTEMPTS`. The wrapped adapter detects the threshold-crossing `verification.update` (parsed via `splitAtLastColon(value)`) and INSERTS a lockout row with `expires_at = now() + 15min` BEFORE BA's subsequent delete fires.
6. New E2E in `apps/storefront/tests/e2e/otp-rate-limit.spec.ts` covers both rate-limit branches (60s request limit + 5-fail lockout) using SQL-fixture backdating.
7. Auth-spec §6 AC#8 + §11.8 + §11.11 hold; tenant-isolation invariant unchanged (same email at tenant A and B remain independent).

## Non-Goals

- ❌ **Redis sliding window** — DB-backed v1 is sufficient; revisit when load > ~10 OTPs/sec/tenant.
- ❌ **Platform OTP** — platform uses email/password, not OTP (auth-spec §4).
- ❌ **IP / device-based limiting** — edge concern, separate phase.
- ❌ **Lockout UI / "X minutes left" countdown** — v1 returns error code + `retryAfterSeconds` in the response body; UI is responsible for displaying it (deferred to a follow-up).
- ❌ **Operator-side lockout admin (unlock/reset)** — out of scope v1; an operator with DB access can `DELETE FROM tenant_otp_lockouts WHERE …` manually.
- ❌ **Per-IP rate limit on top of per-(tenant, email)** — separate concern; out of scope v1.

## BA Behavior (better-auth 1.6.11, verified)

Findings from the §0 spike against `node_modules/.pnpm/better-auth@1.6.11/.../email-otp/`:

- **Call order:** `resolveOTP` (which calls `internalAdapter.createVerificationValue` at `routes.mjs:39`) runs **before** the `sendVerificationOTP` callback (`routes.mjs:104-108`). Therefore the rate-limit check belongs in the **wrapped adapter's `verification.create` path** (Path B), not in the BA callback — by the time the callback fires, the row already exists, and gating it would require excluding the just-created row.
- **Row creation:** default behavior always creates a new row per send (`createVerificationValue` with delete+recreate fallback on uniqueness conflict). Our schema has no unique constraint on `identifier`, so multiple rows coexist. This makes `last_requested_at = defaultNow()` correct — it equals `created_at` in practice but stays accurate if BA ever switches to row-reuse.
- **Attempts encoding:** BA stores attempts inside the `value` column as `${otp_hash}:${N}` (`routes.mjs:39-41, 250, 793`). It uses `splitAtLastColon` (`utils.mjs:11-15`) to parse. **Our existing `tenant_end_user_verifications.attempts INTEGER` column is dead code from BA's perspective** — BA never reads or writes it. We keep the column for backward compatibility / observability, but the rate-limiter reads attempts from `value`.
- **`allowedAttempts` semantics:** on the (N+1)-th attempt where N = `allowedAttempts`, BA reads `attempts >= N` (`routes.mjs:245`), calls `deleteVerificationByIdentifier`, and throws `APIError('FORBIDDEN', TOO_MANY_ATTEMPTS)`. The row dies. **There is no built-in cooldown** — the user can immediately request a new OTP (subject only to our 60s gate).
- **Error serialization:** BA's typed errors use `APIError.from("STATUS", error_code)` where `error_code` is a message string (e.g., `"Too many attempts"`). The client receives a 4xx with the `code` field equal to the dictionary KEY (e.g., `"TOO_MANY_ATTEMPTS"`) — verified pattern in `packages/auth-core/src/storefront-tenant-context.ts:40-51`. We follow the same shape for our rate-limit codes.

**Surface choice: Path B (wrapped adapter).** Confirmed by the call-order finding above. `checkOtpRequest` runs inside the wrapped `verification.create` for `type='otp_login'`, **immediately before** the inner `inner.create(...)`. The check + write happen on the same async tick with no I/O between them.

**Atomicity decision (v1):** The plan called for a Postgres advisory lock around check + write, but the BA `DBAdapter` abstraction doesn't expose the underlying Drizzle connection — calling `inner.create` from within a `db.transaction(...)` callback would still route the BA write through BA's own connection. Session-level `pg_advisory_lock` via separate `db.execute(...)` calls is unreliable under postgres-js's connection pool (lock-holding connections get returned to the pool while held). **Therefore v1 ships WITHOUT the lock — the race is an accepted limitation.** The window is microseconds (between SELECT-latest and INSERT-new on the same wrapped-adapter call); worst-case impact is a user occasionally receiving 2 OTPs instead of 1 if two requests fire simultaneously. This is a UX glitch, not a security issue — attackers still can't bypass the 60s gate over time. v2 path: implement via a Postgres `INSERT ... WHERE NOT EXISTS` pattern or push to a transactional SQL function callable from the adapter without going through BA's internalAdapter.

## Data Model Changes

```sql
-- 1) Add last_requested_at + rate-limit index on existing table
ALTER TABLE tenant_end_user_verifications
  ADD COLUMN last_requested_at timestamptz NOT NULL DEFAULT now();

UPDATE tenant_end_user_verifications
  SET last_requested_at = created_at;

CREATE INDEX tenant_end_user_verifications_rate_limit_idx
  ON tenant_end_user_verifications (tenant_id, identifier, type, last_requested_at DESC);

-- 2) New lockout-tracking table (survives BA's row delete)
CREATE TABLE tenant_otp_lockouts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  identifier text NOT NULL,           -- lowercased email; matches verification.identifier shape
  expires_at timestamptz NOT NULL,    -- when the cooldown lifts
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX tenant_otp_lockouts_lookup_idx
  ON tenant_otp_lockouts (tenant_id, identifier, expires_at DESC);
```

Drizzle equivalent in `packages/db/src/schema.ts`:

```ts
// Extend tenantEndUserVerifications:
lastRequestedAt: timestamp('last_requested_at', { withTimezone: true })
  .notNull()
  .defaultNow(),
// Plus index `tenant_end_user_verifications_rate_limit_idx`.

// New table:
export const tenantOtpLockouts = pgTable('tenant_otp_lockouts', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  identifier: text('identifier').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  lookupIdx: index('tenant_otp_lockouts_lookup_idx')
    .on(t.tenantId, t.identifier, t.expiresAt.desc()),
}));
```

## API Surface

```
// packages/auth-core/src/rate-limit.ts

export const OTP_MAX_FAILURES = 5;
export const OTP_REQUEST_WINDOW_SECONDS = 60;
export const OTP_LOCKOUT_DURATION_SECONDS = 15 * 60;

export const OTP_RATE_LIMIT_CODES = {
  TOO_FREQUENT: 'otp_rate_limit_too_frequent',
  COOLDOWN: 'otp_rate_limit_cooldown',
} as const;

/**
 * Throws APIError('BAD_REQUEST', code) if blocked, else returns clean.
 * Caller MUST already hold an advisory lock on (tenantId, normalized_email)
 * to make this check atomic with a subsequent verification write.
 */
export async function checkOtpRequest(params: {
  tenantId: string;
  email: string;
}): Promise<void>;

/**
 * Records that the (tenant_id, email) attempt counter has crossed the
 * threshold. Called by the wrapped adapter when verification.update sets
 * attempts to OTP_MAX_FAILURES. Inserts a lockout row valid for
 * OTP_LOCKOUT_DURATION_SECONDS.
 */
export async function recordOtpFailure(params: {
  tenantId: string;
  identifier: string; // already-normalized email
}): Promise<void>;

export function normalizeOtpEmail(email: string): string;
```

Wrapped-adapter changes (`packages/auth-core/src/storefront-adapter.ts`):

```
verification.create (for type='otp_login'):
  1. Open db.transaction(tx ⇒ {
  2.   pg_advisory_xact_lock(hashtext(tenantId || ':' || normalized_email))
  3.   await checkOtpRequest({ tenantId, email: data.identifier })
  4.   return inner.create({ ..., last_requested_at: now() }, tx)
  5. })

verification.update (for type='otp_login'):
  - delegate to inner.update as usual
  - parse the new value via splitAtLastColon
  - if parsed attempts === OTP_MAX_FAILURES → await recordOtpFailure(...)
    (fire-and-forget within the same scope; failure to write the lockout
    must NOT block the BA flow — log + Sentry)
```

BA config change (`packages/auth-core/src/storefront.ts`):

```ts
emailOTP({
  // ... existing options ...
  allowedAttempts: OTP_MAX_FAILURES,  // = 5
})
```

No change to the existing `sendVerificationOTP` callback — rate-limit lives in the adapter.

## UI Sketch

No UI in v1. The error response body contains `code` + `message` + (optional) `retryAfterSeconds`. UI work (countdown, locked banner) is a follow-up issue.

## Edge Cases

1. **Same email, two tenants:** independent rate limits. The advisory-lock key includes `tenant_id`; the lockout query is filtered by `tenant_id`. Test #5 in §1.4.
2. **Email normalization:** `JOHN@x.COM`, ` john@x.com `, `john@x.com` all collapse to the same bucket via `normalizeOtpEmail`. BA already calls `.toLowerCase()` (e.g., `routes.mjs:91`); we additionally `.trim()`. Test #6 in §1.4.
3. **Lockout-after-success-mid-attempts:** if the user finally enters the correct OTP on attempt N < 5, BA `consumeOne` deletes the row. No lockout is recorded — correct.
4. **Lockout row cleanup:** v1 does not cron-delete expired rows. The lookup query filters `expires_at > now()`, so they're inert. A scheduled cleanup job is a v2 follow-up.
5. **OTP requested at brand A, attempts exhausted at brand B (same tenant):** the lockout is per `(tenant_id, identifier)` regardless of brand. Both brand subdomains see the same cooldown. Matches tenant-scoped identity per ADR-0003.
6. **Tenant soft-delete during lockout:** `tenant_otp_lockouts.tenant_id` cascade-deletes on tenant hard-delete (30d grace per auth-spec §11.7). During the grace period, lockout still applies — that's fine.
7. **OTP send via Path B fails AFTER advisory lock release:** if `inner.create` throws inside the transaction, the lock releases and no row is written. Next request is treated as fresh — correct.
8. **Lockout write fails:** if `recordOtpFailure` errors (e.g., DB hiccup) while BA is processing the verify path, we log + Sentry but do not block BA. The user just doesn't get the 15-min lockout this once. Acceptable v1 trade-off.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Race condition: concurrent OTP requests for same `(tenant, email)` both pass the 60s check | Medium | Low | v1 ships without the advisory lock (see §BA Behavior "Atomicity decision"). Window is microseconds; worst case user gets 2 OTPs instead of 1. Not a security regression — long-term throttle still ~1 OTP/60s. v2 escalation path documented. |
| BA upgrades change `value` attempts encoding | Low | High | Lock BA version in `pnpm-lock.yaml`; revisit on major-version bump. `splitAtLastColon` import sourced from `node_modules/.../utils.mjs` — if BA refactors, parsing breaks loudly. |
| `recordOtpFailure` write fails silently → no lockout | Low | Medium | Sentry alert on lockout-write failure; review the alert weekly. |
| Lockout state lost when BA deletes row | Resolved | — | New `tenant_otp_lockouts` table is independent of BA's row lifecycle. |
| ~~pg_advisory_xact_lock not transactional under Drizzle postgres-js~~ | — | — | Resolved during implementation: BA's DBAdapter abstraction doesn't share connections with our Drizzle `db.transaction(...)`, so the lock can't span check + `inner.create` cleanly. v1 ships without the lock. |
| New `tenant_otp_lockouts` table grows unbounded | Low | Low | v1 doesn't cron-cleanup; lookup index filters `expires_at > now()` so reads stay fast. Cleanup is a v2 cron. |

## Open Questions

- None at spec-approval time. All §0 spike questions resolved.
- v2-or-later: should the lockout be observable in the storefront UI as a banner with countdown? (Out of scope v1.)
- v2-or-later: cron job to vacuum expired lockout rows? (Out of scope v1.)

## Decisions Log

| Date | Decision | Reasoning |
|---|---|---|
| 2026-05-27 | DB-backed, not Redis | `tenant_end_user_verifications.attempts` column already exists; one column + one small table closes the gap. We don't have Redis in the stack and adding it for one feature isn't justified yet. v2 reconsiders if load > ~10 OTPs/sec/tenant. |
| 2026-05-27 | Path B (wrapped adapter), not Path A (callback) | §0 spike found BA writes the verification row BEFORE the `sendVerificationOTP` callback fires. Callback-based check would see its own write. Adapter-based check runs pre-write and atomic under advisory lock. |
| 2026-05-27 | New `tenant_otp_lockouts` table for cooldown persistence | BA's `allowedAttempts` deletes the verification row on max-attempts. No place on the BA-managed row survives the delete. New table is the cleanest single-table addition with no enum migration. Alternatives considered + rejected: column on `tenant_end_users` (doesn't cover pre-signup case); sentinel row with new `type` enum value (requires enum migration, mixes lifecycle concerns). |
| 2026-05-27 | `allowedAttempts: 5` in BA config | Mirrors auth-spec §6 AC#8 "5 failed attempts" wording. BA's default is 3 — that's stricter but doesn't match the spec. We override to 5. |
| 2026-05-27 | Rate-limit scope = `(tenant_id, lower(email), type='otp_login')` | Aligns with ADR-0003 (tenant-scoped identity) and ADR-0010 (tenant-scoped adapter). Cross-tenant is independent (test #5). Brand is irrelevant for the rate limit — tenant owns the customer identity per ADR-0003. |
| 2026-05-27 | Error code constants exported from `rate-limit.ts` | Tests + spec + future UI all import the same constants. Avoids string-typo drift. Pattern matches BA's `defineErrorCodes`. |

---

## Files that will change

- `packages/db/src/schema.ts` — extend `tenantEndUserVerifications` (`lastRequestedAt` + index), add `tenantOtpLockouts` table.
- `packages/db/migrations/0003_<slug>.sql` (new) — ALTER + CREATE TABLE + CREATE INDEX + backfill UPDATE.
- `packages/auth-core/src/rate-limit.ts` (new) — helper + constants + error-code map.
- `packages/auth-core/src/storefront-adapter.ts` — advisory lock + `checkOtpRequest` call inside `verification.create`; `splitAtLastColon`-based detection + `recordOtpFailure` inside `verification.update`.
- `packages/auth-core/src/storefront.ts` — `+allowedAttempts: 5` on the `emailOTP({ ... })` plugin.
- `packages/auth-core/__tests__/rate-limit.test.ts` (new) — 6 unit cases.
- `apps/storefront/tests/e2e/otp-rate-limit.spec.ts` (new) — 60s window + 5-fail cooldown.
- Maybe `apps/storefront/tests/e2e/fixtures/<helper>.ts` (only if no SQL-write helper exists).
- `packages/db/src/seed.ts` — no change (new column has default; backfill covers existing rows; lockouts table starts empty).
