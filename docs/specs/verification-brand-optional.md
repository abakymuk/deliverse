# Verification brand-optional (DEL-23) — Spec v1

**Created:** 2026-05-27
**Status:** Draft
**Owner:** Vlad
**Issue:** [DEL-23](https://linear.app/oveglobal/issue/DEL-23)
**ADR:** [0012 — Storefront, Brand, Tenant, and Food Hall Architecture](../decisions/0012-storefront-brand-tenant-food-hall-architecture.md)
**Companion spec:** [`docs/specs/ba-brand-optional.md`](./ba-brand-optional.md) — DEL-22's broader implementation contract
**Previous in chain:** DEL-22 (brand-optional BA resolver + tenant-mode emails) — closed in prd.

---

## Problem

Verification rows (`tenant_end_user_verifications` for OTP, email-verify, password-reset) previously stamped `brand_id` unconditionally via the wrapped adapter. ADR-0012 §"Session model (target)" + §"Auth tenant resolution (target)" requires the adapter to be **brand-optional**: brand-host requests stamp the UUID; tenant-host requests leave it NULL and the email template falls back to tenant-level branding.

**DEL-22 absorbed the implementation** to satisfy its own AC#3 (adapter conditional) + AC#4 (no 400 on missing brandId) + AC#6 (§6 auth-spec ACs pass for both modes). The verification adapter line at [storefront-adapter.ts:121](../../packages/auth-core/src/storefront-adapter.ts) writes `brandId: ctx.brandId ?? null` and the tenant-default email-branding fallback lives in `@rp/emails` (handlers branch on `'mode' in data`; templates render `storefront.brandingJson` with fallback to `tenant.logo` / `DELIVERSE_PRIMARY`).

DEL-23 closes two remaining gaps:

1. **The spec at this filename** — DEL-22's `ba-brand-optional.md` covers the broader contract; DEL-23 codifies the verification-specific shape as the canonical doc for that flow.
2. **Full-completion e2e** — DEL-22's e2e asserts HTTP 200 + verification row `brand_id NULL`. DEL-23 extends to extract the plaintext OTP from the Inngest event payload, POST `/api/auth/sign-in/email-otp` with that code, and assert the sign-in completes with a session cookie + tenant-mode session row (`current_brand_id NULL`).

## Users

- **DEL-25 (food-hall UI shell)** — depends on tenant-host OTP signup actually working end-to-end. DEL-23's full-completion e2e is the proof point.
- **Future engineers reading the verification flow** — `verification-brand-optional.md` is the discoverable spec for "how does verification stamping work post-ADR-0012." `ba-brand-optional.md` covers the broader resolver + adapter + emails; this one is the verification-row-specific contract.

## Acceptance Criteria

Verbatim from [DEL-23](https://linear.app/oveglobal/issue/DEL-23):

1. **AC#1 (spec):** this spec is written, reviewed, and linked from DEL-23.
2. OTP request from brand-host storefront → `tenant_end_user_verifications` row has `brand_id` UUID.
3. OTP request from tenant-host storefront → `tenant_end_user_verifications` row has `brand_id` NULL.
4. OTP email branding falls back to a tenant default (logo, name, theme) when `brand_id` is NULL.
5. End-to-end smoke: tenant-host OTP signup completes in dev for the demo food-hall tenant.
6. Brand-host OTP emails unchanged (regression).

### Per-AC status (post-DEL-22, pre-DEL-23)

| AC | Status | Notes |
|---|---|---|
| 1 | **DEL-23 finalizes** | This file. |
| 2 | DEL-22 ✓ | [storefront-adapter.ts:121](../../packages/auth-core/src/storefront-adapter.ts) — `brandId: ctx.brandId ?? null`. Brand-host: ctx.brandId is a UUID → row gets UUID. |
| 3 | DEL-22 ✓ | Same line — tenant-host: ctx.brandId is undefined → row gets NULL. E2E test 8 in [storefront-host-resolution.spec.ts](../../apps/storefront/tests/e2e/storefront-host-resolution.spec.ts) asserts. |
| 4 | DEL-22 ✓ | [emails/handlers/otp-requested.ts](../../packages/emails/src/handlers/otp-requested.ts) branches on `'mode' in data`; [emails/templates/otp.tsx](../../packages/emails/src/templates/otp.tsx) renders `storefront.brandingJson.{primary,logo}` with fallback to `tenant.logo` / `DELIVERSE_PRIMARY`. Unit tests assert the fallback chain. |
| 5 | **DEL-23 finalizes** | DEL-22 e2e asserts HTTP 200 + row brandId NULL. DEL-23 adds the full sign-in completion via Inngest dev OTP extraction. |
| 6 | DEL-22 ✓ | Stg Inngest spot-check confirmed the mode-less back-compat payload for brand-host events. All 23 storefront e2e cases pass. |

## Non-Goals

- ❌ Food-hall UI shell (DEL-25).
- ❌ Tenant theming editor (out of phase scope).
- ❌ Per-brand from-address (separate follow-up; out of M1 scope).
- ❌ Removing the deprecated `extractBrandSlug` export — cleanup PR after M1 closes.
- ❌ Changing BA's `storeOTP: 'hashed'` config. Production setting is correct; the e2e fetches the plaintext from the Inngest event payload (where BA writes it for the email-render path).

## Data Model Changes

None. DEL-23 is docs + tests only. The schema + adapter + email pipeline are all in their post-DEL-22 state.

## API Surface

No new helpers, types, or endpoints. Documentation-only spec for an existing contract.

## Edge Cases

1. **Brand-host OTP** — `ctx.brandId` is a UUID; adapter writes UUID; email handler branches on the absence of `mode` and uses `resolveEmailBrandContext` (brand-mode); template renders `brand.brandingJson` + `brand.name`.
2. **Tenant-host OTP** — `ctx.brandId` is undefined; adapter writes NULL; email handler sees `'mode' in data` → `'tenant'` and uses `resolveTenantStorefrontEmailContext`; template renders `storefront.brandingJson` → `tenant.logo` / `DELIVERSE_PRIMARY` fallback chain.
3. **Missing `storefront.brandingJson`** — falls back to `tenant.logo` / `DELIVERSE_PRIMARY`. Never crashes the template render.
4. **Inngest dev unreachable in tests** — e2e test 9 (full-completion) `test.skip()` with explicit reason. Test 8 (request-side) always runs unaffected.
5. **Inngest reachable but matching OTP event never arrives** — e2e test 9 fails with `OTP event not found in Inngest dev within 30s` — signals a real regression in the BA `sendVerificationOTP` callback or Inngest emit path.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Inngest dev not running locally → test 9 skips | High (CI) | Low | Test 9 skips with a clear reason; test 8 always runs |
| Inngest reachable but OTP event never arrives → test 9 fails | Low | High | Intentional fail-loud signal |
| Verify-OTP body shape drifts from `verify-otp-form.tsx` | Low | Medium | Implementation note: read the form first, mirror byte-for-byte |
| Test 7/8 → 9 ordering breaks under parallel | n/a | n/a | `describe.serial` already enforced |

## Open Questions

None.

## Decisions Log

| Date | Decision | Reasoning |
|---|---|---|
| 2026-05-27 | Spec lives at `verification-brand-optional.md` despite most content in `ba-brand-optional.md` | Linear AC#1 names this exact filename. Companion-spec model: `ba-brand-optional.md` is the broader implementation contract; this file is the verification-row-specific discovery surface |
| 2026-05-27 | OTP plaintext source: Inngest dev API at `:8288` | BA stores OTPs hashed (`storeOTP: 'hashed'` is production-correct); plaintext lives in the Inngest event payload for the email-render path |
| 2026-05-27 | Split into two tests (request-side test 8 + completion-side test 9) | Playwright's `test.skip()` mid-test marks the entire test skipped. Splitting preserves test 8 as always-runs and lets test 9 skip cleanly when Inngest dev is unreachable |
| 2026-05-27 | Test 9 fails (not skips) on Inngest reachable + timeout | Real-regression signal — the BA callback should have emitted the event within seconds |
| 2026-05-27 | Separate `otpSignupEmail` for tests 8/9 (not test-7's password-signup user) | Avoids polluting test-10's password-reset target; OTP-signup creates a new user via `disableSignUp: false`. Cleaner test isolation |
| 2026-05-27 | DEL-22 absorption — DEL-23 does not re-implement | DEL-22's PR #55 commit `7377717` shipped the verification adapter `?? null` + tenant-mode email fallback. DEL-23 is docs + tests only |

---

## Files that will change

- `docs/specs/verification-brand-optional.md` — this file.
- `apps/storefront/tests/e2e/storefront-host-resolution.spec.ts` — add `pollInngestDevForOtp` helper with discriminated-union result; add `otpSignupEmail` test-scoped variable; modify request-side test 8 to use `otpSignupEmail`; add completion-side test 9 (Inngest dev poll + sign-in/email-otp + session-cookie + tenant-mode session-row assertions); renumber password-reset test to test 10.

**Explicitly NOT modified:**

- `packages/auth-core/src/storefront-adapter.ts` — DEL-22 already shipped `?? null`.
- `packages/emails/*` — DEL-22 already shipped the tenant resolver + handlers + templates.
- `packages/auth-core/src/storefront-host.ts:extractBrandSlug` — stays `@deprecated`.
- `packages/auth-core/src/storefront.ts` — `storeOTP: 'hashed'` stays.
