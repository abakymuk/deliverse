# Email delivery architecture — Resend + Inngest + React Email

**Status:** Accepted
**Date:** 2026-05-26
**Owner:** Vlad
**Issue:** [DEL-4](https://linear.app/oveglobal/issue/DEL-4/email-delivery-architecture-adr-spec-for-resend-inngest-templates)
**ADR:** [`0009-emails-package-shape.md`](../decisions/0009-emails-package-shape.md)
**Implementation lands in:** [DEL-5](https://linear.app/oveglobal/issue/DEL-5) (OTP), [DEL-6](https://linear.app/oveglobal/issue/DEL-6) (password reset + email verify)

---

## 1. Goal

Close the architecture decision for how the workspace sends transactional emails so [DEL-5](https://linear.app/oveglobal/issue/DEL-5) and [DEL-6](https://linear.app/oveglobal/issue/DEL-6) can implement mechanically. This issue ships **zero app code** — only:

- This spec.
- An ADR (`docs/decisions/0009-emails-package-shape.md`).
- An **empty skeleton** of `packages/emails/` (`package.json` + `tsconfig.json` only, no source).

## 2. Source of truth

- **Linear:** [DEL-4](https://linear.app/oveglobal/issue/DEL-4) for AC.
- **The four BA stub call sites** in [`packages/auth-core/src/platform.ts`](../../packages/auth-core/src/platform.ts) and [`packages/auth-core/src/storefront.ts`](../../packages/auth-core/src/storefront.ts) — see §5.
- **AGENTS.md "Never Do"** — fire-and-forget side effects in request handlers are banned; emails MUST go through Inngest.
- **`.env.example` lines 38-43 and 56-60** — Resend + Inngest env vars already documented.
- **[`docs/auth-spec.md` §12](../auth-spec.md)** — security posture for OTPs (stored hashed; in-transit handling for the send path is what DEL-4 nails down).
- **[`packages/db/src/schema.ts`](../../packages/db/src/schema.ts)** — `brands` and `tenants` shape, for the package-local brand-context resolver.
- **`apps/storefront/src/lib/tenant-resolution.ts` `getBrandContext`** — **referenced as a pattern, NOT imported**. The emails package defines its own resolver (see §10).

## 3. Scope framing

**In scope:** decisions only. ADR + spec + empty `packages/emails/` skeleton.

**Out of scope** (§13): actual sends ([DEL-5](https://linear.app/oveglobal/issue/DEL-5) / [DEL-6](https://linear.app/oveglobal/issue/DEL-6)), brand-specific from-addresses, IP-based rate limiting, OTP rate limiting ([DEL-9](https://linear.app/oveglobal/issue/DEL-9)), platform OTP (platform doesn't use OTP per `docs/auth-spec.md`), custom retry-policy tuning, dead-letter queue, template versioning.

Storefront BA writes still throw `BetterAuthError` per DEL-11 — that's [DEL-3](https://linear.app/oveglobal/issue/DEL-3)'s problem and is orthogonal to email delivery.

## 4. Decisions

| # | Decision | Rationale |
|---|---|---|
| 1 | **New workspace package `packages/emails/`.** Templates, the Resend client wrapper, and the Inngest functions all live together. Both apps import from `@rp/emails` for type-safe event triggering. | Co-located templates would duplicate the React Email + Resend setup across both apps and split the Inngest function registry. `packages/emails/` is the natural shape — same convention as `packages/auth-core/`. |
| 2 | **Template engine: React Email** (the unified `react-email` package — v6 unified the previously-split `@react-email/components` + `@react-email/render` packages). JSX templates that compile to inline-styled HTML at send time. | Matches the React/JSX everywhere stack; brand-color/logo composition is just prop passing; Resend's own recommended integration; no separate compile step. (Sources: React Email Resend integration docs; React Email 6 changelog.) |
| 3 | **Domain-shaped Inngest events** — `email.otp.requested`, `email.password_reset.requested`, `email.email_verification.requested`. **NOT** a generic `email.send` with switch-on-template. Each event has its own typed payload schema (Zod) and its own Inngest function. | Easier to grep, version per flow, and evolve independently. Maps 1:1 to the four BA stubs. Generic dispatch couples flows together and makes versioning messy. |
| 4 | **Brand data is re-fetched in the Inngest handler, not denormalized into the payload.** The event carries identifiers only (`tenantId`, `brandSlug`, `email`, `otp`, etc.). The handler calls a **package-local** `resolveEmailBrandContext(brandSlug, tenantId)` (defined in `packages/emails/src/brand-context.ts`, using `@rp/db` directly) — **NOT** the storefront app's `getBrandContext`. Workspace dep direction forbids packages importing from apps, and the storefront helper uses Next.js's React `cache()` which doesn't make sense in an Inngest worker. The package-local resolver also verifies `brand.tenantId === tenantId` from the event (defense-in-depth — never render a brand belonging to a different tenant than the event claims). | Avoids stale brand data if branding changes between request and send. Keeps event payloads small + grep-readable. Tenant-ownership check is cheap and rules out a class of cross-tenant template-confusion bugs. |
| 5 | **Inngest functions are registered in ONE place — `apps/platform/src/app/api/inngest/route.ts`.** Both apps trigger events via the `inngest` client, but only the platform app's route handler hosts the functions. Inngest events fan out to all matching registered functions, so registering the same function set from two route handlers would cause **duplicate sends**, not worker-style dedup. | Inngest's events-fanout model is well-documented and easy to misread. The platform app is the natural host (single domain, internal-facing, less request volume). Storefront just calls `inngest.send(...)`. (Sources: Inngest events / function-registration docs.) |
| 6 | **Thin Resend client wrapper** in `packages/emails/src/client.ts` — `sendEmail({ to, subject, react, text? })` that calls `resend.emails.send` and normalizes errors. Reads `RESEND_API_KEY` + `RESEND_FROM_EMAIL` from env at module load. | Centralized error handling + logging + a single test point. No magic, no retry logic (Inngest handles retries at the function layer). |
| 7 | **Single global `RESEND_FROM_EMAIL` for v1.** Brand-specific sender domains (`noreply@pizza-express.deliverse.app`) are deferred to a later issue. | Sender domains require DNS records (SPF, DKIM, DMARC) per brand — operational complexity not justified before private beta. |
| 8 | **Retry policy: Inngest defaults** (4 retries with exponential backoff) for the first ship. No custom retry shape. Idempotency keys derived from the event's `eventId` field. BA hook calls are intrinsically not idempotent; the spec calls this out as an accepted v1 limitation — a duplicate OTP email is annoying, not dangerous. | Defer custom retry tuning until we see real failure modes. |
| 9 | **ADR-0009 enumerates the deps that DEL-5 / DEL-6 will install.** No `pnpm add` runs in DEL-4 — skeleton ships with empty `dependencies: {}`. Deps named: `inngest`, `resend`, `react-email` (v6 unified), `react`, `zod` (for event schemas), `@rp/db` (workspace, for the brand-context resolver). The actual install in DEL-5/DEL-6 may reveal subtleties (peer deps, version constraints) that override the ADR — when that happens, ADR-0009 is updated to match reality, mirroring how ADR-0008 was written *after* the shadcn CLI diff. | Per Linear AC #3 ("the package skeleton (empty) is checked in with `package.json` + `tsconfig.json` only"). The dep list is documentation, not installation, in this issue. |
| 10 | **OTP plaintext in Inngest event payloads is sensitive.** `email.otp.requested.data.otp` carries the plaintext 6-digit code — the storefront BA hashes it for DB storage per DEL-11, but the send path needs the plaintext to put in the email body. Inngest stores event payloads, so DEL-5's implementation **MUST**: (a) classify this field as sensitive in the code (TSDoc + a comment-level `// SENSITIVE` tag), (b) never log it (handler must redact in any log lines — `{ ...data, otp: '***' }` style), (c) avoid `console.log({ event })` style debug aids. The OTP's window of exposure is ≤10 min (TTL) + Inngest event retention; acceptable for v1, revisitable if Inngest retention becomes a concern. | Inngest's value is durable events; that durability is also the risk surface here. Better to call this out in the spec than discover it through a leaked dev log. |

## 5. The four BA stub call sites (DEL-5/DEL-6 contract)

DEL-5/DEL-6 must hit each callback signature verbatim. These are the contract.

| BA hook | Instance | Callback signature | Maps to event |
|---|---|---|---|
| `emailAndPassword.sendResetPassword` | platform | `async ({ user, url }) => …` | `email.password_reset.requested` with `instance: 'platform'` |
| `emailVerification.sendVerificationEmail` | platform | `async ({ user, url }) => …` | `email.email_verification.requested` with `instance: 'platform'` |
| `emailAndPassword.sendResetPassword` | storefront | `async ({ user, url }) => …` | `email.password_reset.requested` with `instance: 'storefront'` (carries `tenantId` + `brandSlug` from a request-scoped resolver — DEL-3's surface) |
| `emailOTP.sendVerificationOTP` | storefront | `async ({ email, otp, type }) => …` where `type ∈ { 'otp_login', 'email_verify', 'password_reset' }` | `email.otp.requested` (storefront-only event; always carries `tenantId` + `brandSlug`) |

The platform stubs at [`platform.ts:91-101`](../../packages/auth-core/src/platform.ts) and the storefront `sendResetPassword` stub at [`storefront.ts:131-133`](../../packages/auth-core/src/storefront.ts) stay as `console.log` until DEL-6 swaps the body for `inngest.send(...)`. The storefront `sendVerificationOTP` stub was replaced by DEL-5 — see [`docs/specs/otp-email.md`](./otp-email.md) for the implementation reference.

## 6. Inngest event schemas

Zod **discriminated unions** per event. Platform-instance variants carry no tenant context; storefront-instance variants **require** `tenantId` + `brandSlug` at the type level. The OTP event is storefront-only.

```ts
// packages/emails/src/events.ts (DEL-5/DEL-6 write this; DEL-4 specs it)
import { z } from 'zod';

// ── OTP (storefront only) ────────────────────────────────────────────────
// SENSITIVE: data.otp is plaintext — never log, never expose in error
// messages. Decision #10 classifies this as the security note.
export const otpRequestedEvent = z.object({
  name: z.literal('email.otp.requested'),
  data: z.object({
    email: z.string().email(),
    otp: z.string().regex(/^\d{6}$/), // SENSITIVE
    type: z.enum(['otp_login', 'email_verify', 'password_reset']),
    tenantId: z.string().uuid(),
    brandSlug: z.string(),
  }),
});

// ── Password reset — discriminated union by instance ─────────────────────
const passwordResetCommon = z.object({
  email: z.string().email(),
  userId: z.string().uuid(),
  url: z.string().url(),
});
export const passwordResetRequestedEvent = z.object({
  name: z.literal('email.password_reset.requested'),
  data: z.discriminatedUnion('instance', [
    passwordResetCommon.extend({ instance: z.literal('platform') }),
    passwordResetCommon.extend({
      instance: z.literal('storefront'),
      tenantId: z.string().uuid(),
      brandSlug: z.string(),
    }),
  ]),
});

// ── Email verification — same shape ──────────────────────────────────────
const emailVerificationCommon = passwordResetCommon; // identical fields
export const emailVerificationRequestedEvent = z.object({
  name: z.literal('email.email_verification.requested'),
  data: z.discriminatedUnion('instance', [
    emailVerificationCommon.extend({ instance: z.literal('platform') }),
    emailVerificationCommon.extend({
      instance: z.literal('storefront'),
      tenantId: z.string().uuid(),
      brandSlug: z.string(),
    }),
  ]),
});
```

The discriminated union makes `instance: 'storefront'` → `tenantId + brandSlug` a **type-level requirement**, not a convention. Callers that pass `instance: 'storefront'` without the tenant fields fail at the `inngest.send(...)` call site, not at runtime in the handler.

## 7. Inngest function shape

For each event, **one function** that:

1. Parses the payload via the matching Zod schema.
2. Re-fetches brand context via `resolveEmailBrandContext(brandSlug, tenantId)` when `data.instance === 'storefront'` (or unconditionally for `email.otp.requested`). Verifies `brand.tenantId === data.tenantId` — see §10.
3. Renders the React Email template via `react-email` (the v6 unified package — see Decision #2; the older `@react-email/components` + `@react-email/render` split is historical context only).
4. Calls the Resend wrapper (§8).

**Retry policy:** Inngest defaults. **Idempotency:** Inngest's per-event idempotency keyed on `eventId`. **Registration:** Functions are registered ONCE — in `apps/platform/src/app/api/inngest/route.ts`. Never in both apps.

## 8. Resend client wrapper

```ts
// packages/emails/src/client.ts (DEL-5 writes this; DEL-4 specs it)
export type SendEmailArgs = {
  to: string;
  subject: string;
  react: React.ReactElement;
  text?: string;
};
export async function sendEmail(args: SendEmailArgs): Promise<{ id: string }> {
  // 1. Validate env on first call (RESEND_API_KEY required in prod;
  //    warn + no-op in dev/test when missing — see §11).
  // 2. Call resend.emails.send({ from: RESEND_FROM_EMAIL, ...args }).
  // 3. Normalize errors (throw `EmailSendError` with cause).
  // 4. Log a structured success line (no sensitive fields).
  // 5. Return { id } from Resend's response.
}
```

Env vars validated at module load:
- **Production** (`NODE_ENV === 'production'`): `RESEND_API_KEY` and `RESEND_FROM_EMAIL` required; throws if missing.
- **Dev / test:** missing `RESEND_API_KEY` is allowed; client no-ops with a `[DEV] would send: { to, subject, body-preview }` structured log instead. **The dev log NEVER includes the plaintext OTP** — handlers redact `otp: '***'` before passing data to logger.

## 9. Package directory structure

```
packages/emails/src/
  ├── client.ts              # Resend wrapper (§8)
  ├── events.ts              # Zod event schemas (§6, single source of truth)
  ├── brand-context.ts       # resolveEmailBrandContext(brandSlug, tenantId)
  │                          # Uses @rp/db directly; NOT the storefront's
  │                          # getBrandContext (different runtime, different
  │                          # caching shape, wrong dep direction).
  ├── inngest/
  │   ├── client.ts          # Inngest client (event sender)
  │   ├── index.ts           # Function registry (consumed by platform's
  │   │                      # /api/inngest route handler ONLY)
  │   ├── otp.ts             # email.otp.requested handler
  │   ├── password-reset.ts  # email.password_reset.requested handler
  │   └── email-verify.ts    # email.email_verification.requested handler
  └── templates/
      ├── otp.tsx            # React Email template (storefront, branded)
      ├── password-reset.tsx # instance-discriminated layout
      └── email-verify.tsx   # instance-discriminated layout
```

DEL-5 creates the first OTP slice (`client.ts`, `events.ts`, `brand-context.ts`, `inngest/{client,index,otp}.ts`, `templates/otp.tsx`). DEL-6 adds the two remaining flows.

## 10. Brand-theming + tenant-ownership pattern

For events where `data.instance === 'storefront'` (or always for `email.otp.requested`), the Inngest handler calls `resolveEmailBrandContext(brandSlug, tenantId)` — a package-local function in `packages/emails/src/brand-context.ts` that uses `@rp/db` directly.

The resolver:

1. Joins `brands` ⨝ `tenants` on `brands.slug = brandSlug AND brands.deletedAt IS NULL AND tenants.deletedAt IS NULL AND tenants.status = 'active' AND brands.isActive = true`.
2. **Verifies `result.brand.tenantId === tenantId`** (the value from the event payload). Defense in depth — rejects cross-tenant brand references that could arise from a forged or buggy event.
3. Returns `{ brand, tenant }` or **throws** a typed `BrandResolutionError`. Inngest retries on throw per the default policy; after retries exhaust, the event lands in Inngest's failed-event view.

**Why not import `apps/storefront/src/lib/tenant-resolution.ts:getBrandContext`?**

- Workspace dep direction violation: packages cannot import from apps.
- That helper uses React `cache()` (Next.js per-request memoization) — meaningless inside an Inngest worker.
- The Inngest handler has different caching needs (it's a one-shot per event, not per request).

Platform sends (`instance: 'platform'`) skip the resolver entirely and render with a plain "Deliverse" branding fallback baked into the templates.

## 11. Local-dev story

- **Inngest CLI** (`pnpm dlx inngest-cli@latest dev`) runs on port 8288. Both apps' `inngest` clients auto-detect and connect to it when `INNGEST_EVENT_KEY` is unset.
- **Only the platform app's `/api/inngest` route handler registers functions.** Storefront just calls `inngest.send(...)`. Registering the same functions from two handlers causes duplicate sends (per Decision #5).
- **Resend client no-ops in dev** when `RESEND_API_KEY` is missing — the dev console gets a `[DEV] would send: { to, subject, body-preview }` line instead of a real API call. The plaintext OTP is replaced with `***` in any log line.

### 11a. Doppler env-var setup per environment

All four env vars are documented at [`.env.example` lines 38-43 + 56-60](../../.env.example). They are **not** needed in DEL-4 — this issue ships zero code that reads them — but DEL-5 / DEL-6 need them set before the first real send.

| Env var | dev | stg | prd |
|---|---|---|---|
| `RESEND_API_KEY` | **Optional.** Leave empty → wrapper no-ops with `[DEV] would send: ...`. Or set a Resend **test key** (`re_test_...`) from [resend.com/api-keys](https://resend.com/api-keys) → "Create API Key" → permission `Sending access`. | **Required.** Real Resend live key, scoped to staging in Resend's UI if available. | **Required.** Real Resend live key, separate from stg. |
| `RESEND_FROM_EMAIL` | `onboarding@resend.dev` (Resend's free sandbox — sends only to the account-owner email; no DNS setup). | `noreply@staging.deliverse.app` if you verify that subdomain in Resend, otherwise stay on `onboarding@resend.dev`. | **`noreply@deliverse.app`** (or your final choice). **Must be a verified domain** with SPF + DKIM + DMARC records at the DNS registrar. Resend's dashboard walks through the records under Domains → Add Domain → Verify. Plan ~24h DNS propagation. |
| `INNGEST_EVENT_KEY` | **Optional.** Leave empty → Inngest SDK falls back to local-CLI mode on port 8288. | **Required.** From [app.inngest.com](https://app.inngest.com) → your app → Environments → Staging → Event Keys → "Create Event Key". | **Required.** Same flow, Environments → Production. Separate key per env. |
| `INNGEST_SIGNING_KEY` | **Optional.** Same — CLI handles signing locally. | **Required.** Same Inngest UI, same env → Signing Keys. Used by `/api/inngest` to verify incoming function-invocation requests from Inngest Cloud. | **Required.** Separate key per env. |

**Doppler CLI commands:**

```bash
# Scope CLI to a specific config once
doppler setup --config dev      # or stg / prd

# dev — keep Inngest empty; Resend optional (test mode if set)
doppler secrets set RESEND_API_KEY="re_test_..." --config dev          # optional
doppler secrets set RESEND_FROM_EMAIL="onboarding@resend.dev" --config dev  # optional
doppler secrets delete INNGEST_EVENT_KEY --config dev    # if previously set
doppler secrets delete INNGEST_SIGNING_KEY --config dev  # if previously set

# stg — all four required
doppler secrets set RESEND_API_KEY="re_..." --config stg
doppler secrets set RESEND_FROM_EMAIL="noreply@staging.deliverse.app" --config stg
doppler secrets set INNGEST_EVENT_KEY="..." --config stg
doppler secrets set INNGEST_SIGNING_KEY="..." --config stg

# prd — verified domain required first
doppler secrets set RESEND_API_KEY="re_..." --config prd
doppler secrets set RESEND_FROM_EMAIL="noreply@deliverse.app" --config prd
doppler secrets set INNGEST_EVENT_KEY="..." --config prd
doppler secrets set INNGEST_SIGNING_KEY="..." --config prd
```

**Verification per env:**

```bash
doppler run --config dev -- env | grep -E "^(RESEND|INNGEST)_"
doppler run --config stg -- env | grep -E "^(RESEND|INNGEST)_"
doppler run --config prd -- env | grep -E "^(RESEND|INNGEST)_"
```

Expect the optional-in-dev vars to be absent (or test values), and all four set in stg + prd.

**Prerequisites timeline:**
- **Before DEL-5 merges to staging:** stg's four env vars set in Doppler; staging Inngest environment created in Inngest Cloud; if using `noreply@staging.deliverse.app`, staging domain verified in Resend.
- **Before DEL-5 merges to main:** prd's four env vars set; prd Inngest environment created; `deliverse.app` domain verified in Resend with DKIM/SPF/DMARC. **Plan the DNS work a day ahead** — Resend won't accept the from-address until verification clears.
- **Doppler does NOT auto-promote secrets dev → stg → prd.** Each config is set independently. AGENTS.md "Hard rules" §3 — "No env var added to prd without dev and stg first" — is a workflow rule, not a Doppler feature; enforce it by setting in dev → stg → prd order.

## 12. Files that change in DEL-4 (this issue)

- This file (`docs/specs/email-delivery.md`) — new.
- [`docs/decisions/0009-emails-package-shape.md`](../decisions/0009-emails-package-shape.md) — new ADR.
- `packages/emails/package.json` — new, **empty skeleton**, no `typecheck` script, no `dependencies`.
- `packages/emails/tsconfig.json` — new, extends `@rp/typescript-config/library.json` with `jsx: 'react-jsx'`.
- `packages/emails/src/` — **NOT created.** DEL-5 creates the first source files.

## 13. Out of scope

- Actual sends — [DEL-5](https://linear.app/oveglobal/issue/DEL-5) (OTP) and [DEL-6](https://linear.app/oveglobal/issue/DEL-6) (password reset + email verify) implement against this spec.
- Brand-specific sender domains (`noreply@<brand>.deliverse.app`) — needs per-brand DNS verification; defer to post-private-beta.
- IP-based rate limiting — edge concern; out of scope v1.
- OTP rate limiting — [DEL-9](https://linear.app/oveglobal/issue/DEL-9).
- Platform OTP — platform doesn't use OTP per spec.
- Custom retry-policy tuning — defer until real failure modes surface.
- Dead-letter queue — Inngest's failed-event view is the v1 substitute.
- Template versioning / copy rollback — defer until first time we need to roll back a template.

## 14. Verification checklist

- [ ] `pnpm install` re-resolves the workspace cleanly with `packages/emails/` present; no new deps fetched.
- [ ] `pnpm-workspace.yaml`'s `packages/*` glob picks up `packages/emails/` — confirmed by `pnpm list -r --depth -1` showing `@rp/emails`.
- [ ] `pnpm -r typecheck` clean across all workspace projects with a `typecheck` script; `@rp/emails` is skipped intentionally because the package has no `typecheck` script (`tsc` would error with `TS18003: No inputs were found` against an empty `src/`; DEL-5 adds the script back when the first source file lands).
- [ ] ADR-0009 enumerates the anticipated deps with the React Email v6 single-package shape (`react-email`, not `@react-email/components` + `@react-email/render`).
- [ ] No BA config changes; no Resend or Inngest deps installed; no source files under `packages/emails/src/`.
- [ ] Spec cross-links cleanly to `docs/auth-spec.md`, AGENTS.md, ADR-0009, and the BA stub call sites.
