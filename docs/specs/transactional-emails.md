# Transactional emails — password reset + email verification

**Status:** Draft
**Date:** 2026-05-26
**Owner:** Vlad
**Issue:** [DEL-6](https://linear.app/oveglobal/issue/DEL-6)
**Blocked by:** [DEL-4](https://linear.app/oveglobal/issue/DEL-4) ✓ (architecture lock), [DEL-5](https://linear.app/oveglobal/issue/DEL-5) ✓ (first real send + implementation pattern)
**Builds on:** [`email-delivery.md`](./email-delivery.md), [`otp-email.md`](./otp-email.md), [`0009-emails-package-shape.md`](../decisions/0009-emails-package-shape.md), [`0011-emails-install-diff.md`](../decisions/0011-emails-install-diff.md)
**Unblocks:** [DEL-7](https://linear.app/oveglobal/issue/DEL-7) (signup pages — non-OAuth flows can now verify email + recover passwords)

---

## 1. Goal

Close the remaining transactional-email stubs after DEL-5 shipped the OTP slice. Replace the three `console.log` callbacks in [`packages/auth-core/src/{platform,storefront}.ts`](../../packages/auth-core/src/) with real `inngest.send` → `packages/emails` handler → Resend pipelines. Reuses the exact pattern DEL-5 established — no new architectural decisions.

After this issue ships: every BA-invoked email path in the workspace is real. Auth-spec §6 AC#3 (password reset on platform + storefront) and signup email verification on platform become achievable.

## 2. Source of truth

- **DEL-4 architecture spec:** [`docs/specs/email-delivery.md`](./email-delivery.md) §5 (the four BA stubs, **of which DEL-5 closed one**) + §6 (Zod discriminated-union event schemas, restated verbatim in §5 of this spec) + §10 (platform sends skip the brand resolver). Non-negotiable.
- **DEL-5 implementation pattern:** [`docs/specs/otp-email.md`](./otp-email.md) §6 (pure-handler + thin Inngest wrapper) + §7 (storefront `brandSlug` plumbing) + §8 (resolver) + §10 (Resend wrapper).
- **The three remaining stubs**:
  - [`platform.ts:91-93`](../../packages/auth-core/src/platform.ts) — `emailAndPassword.sendResetPassword`.
  - [`platform.ts:99-101`](../../packages/auth-core/src/platform.ts) — `emailVerification.sendVerificationEmail`.
  - [`storefront.ts:131-133`](../../packages/auth-core/src/storefront.ts) — `emailAndPassword.sendResetPassword`.
- **BA installed source** (verified at spec time):
  - `packages/auth-core/node_modules/better-auth/dist/api/routes/password.mjs:64` — `resetPasswordTokenExpiresIn || 3600 * 1` → reset link valid for **1 hour** by default. Our configs do not override.
  - `packages/auth-core/node_modules/better-auth/dist/api/routes/password.mjs:72` — reset URL constructed as `${ctx.context.baseURL}/reset-password/<token>?callbackURL=<redirectTo>`. `ctx.context.baseURL` is **static** (frozen at init from `BETTER_AUTH_URL`). Storefront BA rewrites the origin per-request in its callback to the user's brand subdomain — see [DEL-15](https://linear.app/oveglobal/issue/DEL-15) + [`del-15-storefront-baseurl.md`](./del-15-storefront-baseurl.md).
  - `packages/auth-core/node_modules/better-auth/dist/api/routes/email-verification.mjs:12` — `expiresIn = 3600` → verification link also **1 hour**. Our configs do not override.
  - `packages/auth-core/node_modules/better-auth/dist/api/routes/email-verification.mjs:36` — endpoint is `createAuthEndpoint("/send-verification-email", …)`, mounted at `/api/auth/send-verification-email`.
- **DEL-6 Linear AC** — see §3 reconciliation; AC #2 + AC #4 wording is stale and should be edited post-merge.

## 3. Scope reconciliation — 3 stubs, not 4

DEL-6's Linear AC #2 says "four `console.log` stubs" and AC #4 implies a storefront email-verification template. Both are stale relative to the locked DEL-4 spec §5 table, which lists:

| BA hook | Instance | DEL-6? |
|---|---|---|
| `emailAndPassword.sendResetPassword` | platform | ✓ |
| `emailVerification.sendVerificationEmail` | platform | ✓ |
| `emailAndPassword.sendResetPassword` | storefront | ✓ |
| `emailOTP.sendVerificationOTP` | storefront | DEL-5 shipped |

That's **three stubs**, not four. The storefront has **no non-OTP `sendVerificationEmail` callback** because [`storefront.ts:126-134`](../../packages/auth-core/src/storefront.ts) has `autoSignIn: true` with no `requireEmailVerification` flag — BA never invokes verification on storefront email/password signup. Email verification on the storefront is OTP-shaped (DEL-5's `email_verify` OTP `type` already covers it).

If a future product decision flips `requireEmailVerification: true` on the storefront BA, the work is additive: extend `emailVerificationRequestedEvent`'s discriminated union with a storefront variant + add a brand-themed template + add a switch case in the handler. The schema in §5 below is set up to accept that without rewriting. **Out of scope for DEL-6.**

## 4. Decisions

| # | Decision | Rationale | Source |
|---|---|---|---|
| 1 | **Two new event types**, both Zod discriminated unions on `instance` per DEL-4 §6. `passwordResetRequestedEvent` has variants `platform` + `storefront` (the latter carries `tenantId` + `brandSlug`). `emailVerificationRequestedEvent` has only a `platform` variant today — kept as a discriminated union for forward-compat per §3. | Single source of truth. Future storefront verification doesn't require schema rewrite. | DEL-4 §6 |
| 2 | **`url` only — no `token` in event payload.** BA passes `{ user, url, token }` to the callbacks but the user-facing target URL embeds the token. Including the raw token in the event payload widens the sensitive-data surface for zero benefit. | YAGNI + same security instinct as DEL-5's "no body preview in Resend dev-no-op log". | this spec |
| 3 | **Platform variants skip the brand-context resolver** and render with a neutral "Deliverse" header baked into the template. Storefront password-reset uses `resolveEmailBrandContext` (reused from `packages/emails/src/brand-context.ts`) with the same tenant-ownership defense as DEL-5. | DEL-4 §10. Cleanly separates the two render paths. | DEL-4 §10 |
| 4 | **Shared style chrome extracted to `packages/emails/src/templates/_styles.ts`.** All three templates (OTP, password-reset, email-verify) reuse `bodyStyle`, `containerStyle`, `headerStyle`, `contentStyle`, `headingStyle`, `textStyle`, `mutedTextStyle`, `footerStyle`. Per-template specifics (OTP's `codeStyle`, button styles) stay inline. | Three templates is the right size to extract; refactoring the OTP template at this size is cheap and forces the chrome to be visibly single-sourced. | this spec |
| 5 | **Handlers switch on `data.instance` even when single-variant.** `handleEmailVerificationRequested` has only a `platform` case today but the `switch (data.instance)` shape is identical to `handlePasswordResetRequested`. Future storefront variant becomes a one-case addition. | Symmetric handlers; cheap forward-compat. | this spec |
| 6 | **Reset / verification link TTL is the BA default — 1 hour.** Confirmed from installed source (§2). Templates can cite "1 hour" directly. Spec note: if a future BA version changes the default, copy needs revisiting. | Don't hedge what you've verified. | BA dist refs in §2 |
| 7 | **Platform module-level `inngest` import.** Platform BA is a top-level `betterAuth(...)` call ([`platform.ts:37`](../../packages/auth-core/src/platform.ts)) — no factory closure. The two platform callbacks `import { inngest } from '@rp/emails/inngest'` at the top of `platform.ts` and call `inngest.send(...)` directly. Storefront `sendResetPassword` reuses the OTP callback's pattern (closes over `resolveTenantContext`). | Matches existing structure; no factory refactor needed. | DEL-5 reused the storefront factory because OTP needed `brandSlug` plumbing; platform events have no tenant/brand context, so no closure is required. |

## 5. Event payload contracts — `email.password_reset.requested` + `email.email_verification.requested`

Frozen by DEL-4 spec §6; restated here so this file is self-contained.

```ts
// packages/emails/src/events.ts (extended in this issue)
import { z } from 'zod';

const transactionalEmailCommon = z.object({
  email: z.string().email(),
  userId: z.string().uuid(),
  url: z.string().url(),
});

// ── Password reset — discriminated by instance ──────────────────────────
export const passwordResetRequestedEvent = z.object({
  name: z.literal('email.password_reset.requested'),
  data: z.discriminatedUnion('instance', [
    transactionalEmailCommon.extend({ instance: z.literal('platform') }),
    transactionalEmailCommon.extend({
      instance: z.literal('storefront'),
      tenantId: z.string().uuid(),
      brandSlug: z.string().min(1),
    }),
  ]),
});

// ── Email verification — single-variant discriminated union (forward-compat) ──
export const emailVerificationRequestedEvent = z.object({
  name: z.literal('email.email_verification.requested'),
  data: z.discriminatedUnion('instance', [
    transactionalEmailCommon.extend({ instance: z.literal('platform') }),
  ]),
});

export type PasswordResetRequestedData = z.infer<
  typeof passwordResetRequestedEvent
>['data'];
export type EmailVerificationRequestedData = z.infer<
  typeof emailVerificationRequestedEvent
>['data'];
```

The discriminated union makes `instance: 'storefront'` → `tenantId + brandSlug` a **type-level requirement** at the `inngest.send(...)` call site. Callers that pass `instance: 'storefront'` without the tenant fields fail at compile time, not at runtime in the handler.

## 6. Handler shape — pure function + thin Inngest wrapper

Same split as [`docs/specs/otp-email.md`](./otp-email.md) §6.

```ts
// packages/emails/src/handlers/password-reset-requested.ts (pure)
export async function handlePasswordResetRequested(
  data: PasswordResetRequestedData,
): Promise<{ id: string }> {
  passwordResetRequestedEvent.shape.data.parse(data);

  if (data.instance === 'storefront') {
    const { brand, tenant } = await resolveEmailBrandContext(
      data.brandSlug,
      data.tenantId,
    );
    return sendEmail({
      to: data.email,
      subject: `Reset your password for ${brand.name}`,
      react: PasswordResetEmail({
        instance: 'storefront',
        brand,
        tenant,
        url: data.url,
      }),
    });
  }

  // instance: 'platform'
  return sendEmail({
    to: data.email,
    subject: 'Reset your Deliverse password',
    react: PasswordResetEmail({ instance: 'platform', url: data.url }),
  });
}
```

```ts
// packages/emails/src/handlers/email-verification-requested.ts (pure)
export async function handleEmailVerificationRequested(
  data: EmailVerificationRequestedData,
): Promise<{ id: string }> {
  emailVerificationRequestedEvent.shape.data.parse(data);

  // Single switch arm today; same shape as the password-reset handler so a
  // future storefront variant slots in symmetrically (decision #5).
  switch (data.instance) {
    case 'platform':
      return sendEmail({
        to: data.email,
        subject: 'Verify your Deliverse email',
        react: EmailVerificationEmail({ instance: 'platform', url: data.url }),
      });
  }
}
```

The Inngest function wrappers in `packages/emails/src/inngest/{password-reset,email-verify}.ts` are one-liners identical in shape to [`inngest/otp.ts`](../../packages/emails/src/inngest/otp.ts), with `InngestFunction.Any` type annotation to dodge TS2742.

## 7. Templates — shared chrome + per-template specifics

Three templates after this issue: `otp.tsx`, `password-reset.tsx`, `email-verify.tsx`. Shared layout chrome is extracted into `packages/emails/src/templates/_styles.ts` (decision #4). Per-template files import the shared styles + define their own per-template specifics (e.g., OTP's `codeStyle` for the giant monospaced digits; password-reset/verify's button styles).

All three import from `'react-email'` (unified v6 package per ADR-0011): `{ Html, Head, Body, Container, Section, Text, Heading, Img, Button, Preview }`. **`Button` is the new import for the action-link templates.**

### 7a. Platform "Deliverse" header

When `instance === 'platform'`, both new templates skip the brand-context block and render a neutral header — just the text "Deliverse" styled with the brand-heading style. No logo URL, no jsonb branding lookup. Same neutral header in both templates so they stay visually consistent.

### 7b. Body copy (verified TTLs)

- Password reset: heading "Reset your password" → instruction "Click the button below to reset your password." → `<Button href={url}>Reset password</Button>` → muted "This link expires in 1 hour. If you didn't request this, you can safely ignore this email." (TTL confirmed from BA source per §2.)
- Email verify: heading "Verify your email" → instruction "Click the button below to verify your email address." → `<Button href={url}>Verify email</Button>` → same 1-hour expiry note.
- Storefront password-reset variant: same body but the header swaps in `brand.brandingJson.logo` / `brand.name` and the subject uses the brand name (`"Reset your password for ${brand.name}"`).

## 8. Wiring — three callbacks

### 8a. Storefront `sendResetPassword` ([`storefront.ts:131-133`](../../packages/auth-core/src/storefront.ts))

Closes over `resolveTenantContext` (already wired by DEL-3 + DEL-5). After DEL-15 also post-processes the BA-constructed URL so the origin matches the brand subdomain instead of the platform host.

```ts
sendResetPassword: async ({ user, url }) => {
  const ctx = await resolveTenantContext();
  // DEL-15: rewrite origin to user's brand subdomain — storefront BA can't
  // use a static baseURL because it serves all brands from one instance.
  const baseDomain = process.env.NEXT_PUBLIC_STOREFRONT_BASE_DOMAIN;
  if (!baseDomain) throw new Error('NEXT_PUBLIC_STOREFRONT_BASE_DOMAIN required');
  const proto = process.env.NODE_ENV === 'production' ? 'https' : 'http';
  const rewrittenUrl = rewriteStorefrontEmailUrl({
    originalUrl: url,
    brandSlug: ctx.brandSlug,
    baseDomain,
    proto,
  });
  await inngest.send({
    name: 'email.password_reset.requested',
    data: {
      instance: 'storefront',
      email: user.email,
      userId: user.id,
      url: rewrittenUrl,
      tenantId: ctx.tenantId,
      brandSlug: ctx.brandSlug,
    },
  });
},
```

### 8b. Platform `sendResetPassword` ([`platform.ts:91-93`](../../packages/auth-core/src/platform.ts)) + `sendVerificationEmail` ([`platform.ts:99-101`](../../packages/auth-core/src/platform.ts))

Platform BA is a top-level `betterAuth(...)` export — no factory closure. Add `import { inngest } from '@rp/emails/inngest'` at the top of the file, then:

```ts
sendResetPassword: async ({ user, url }) => {
  await inngest.send({
    name: 'email.password_reset.requested',
    data: { instance: 'platform', email: user.email, userId: user.id, url },
  });
},
sendVerificationEmail: async ({ user, url }) => {
  await inngest.send({
    name: 'email.email_verification.requested',
    data: { instance: 'platform', email: user.email, userId: user.id, url },
  });
},
```

## 9. Verification

### 9a. Automated (CI)

- `packages/emails/__tests__/password-reset.test.ts` — happy paths for both `instance` variants (platform + storefront), schema-rejection negatives (non-UUID `userId`, non-URL `url`), rendered HTML contains the brand name (storefront) / "Deliverse" (platform), `sendEmail` called with the right subject + recipient.
- `packages/emails/__tests__/email-verify.test.ts` — happy path (platform), schema-rejection negative, rendered HTML contains "Verify your email" + the URL.
- Existing OTP tests still pass after the `_styles.ts` extraction (the rendered-HTML assertions act as regression coverage for the chrome refactor).
- `pnpm --filter @rp/emails test` → 18+/18+ green. `pnpm -r typecheck` + `pnpm exec biome check` clean.

### 9b. Manual local-dev (PR description checklist)

Setup same as DEL-5. If Doppler dev still has `INNGEST_EVENT_KEY`/`INNGEST_SIGNING_KEY` set, run with `env -u INNGEST_EVENT_KEY -u INNGEST_SIGNING_KEY INNGEST_DEV=1` to force local mode (or delete those keys from dev per the DEL-5 follow-up note).

```bash
# Terminal 1
pnpm dlx inngest-cli@latest dev

# Terminal 2 (env-unset variant if cloud keys still in dev)
doppler run --config dev -- env -u INNGEST_EVENT_KEY -u INNGEST_SIGNING_KEY INNGEST_DEV=1 pnpm dev
```

**Clickable UI shipped in DEL-7** — `/signup`, `/forgot-password`, `/reset-password` pages now exist on both apps. The curl smoke below still works but you can also drive the same flows from the browser. The `redirectTo: '/reset-password'` in the curl recipes matches the DEL-7 page so the BA-constructed email link lands on the form (mandatory per `password.mjs:115` — without `redirectTo`, BA throws `INVALID_TOKEN`).

For each flow, confirm: event fires with the right shape in Inngest dev UI (port 8288); handler runs green; platform terminal logs `[DEV] would send: { to, subject }` with correct subject and **no `url` in the log line** (same redaction discipline as the OTP path).

1. **Platform password reset** — endpoint confirmed from installed source (§2): `POST /api/auth/request-password-reset` (NOT `/forget-password`; that's a common BA mis-recollection — `password.mjs:20`). BA returns 200 silently if the user doesn't exist (enumeration protection), so use a seeded user like `admin@test.local`. Subject: `"Reset your Deliverse password"`. Event `data.instance === 'platform'`.

   ```bash
   curl -X POST http://localhost:3000/api/auth/request-password-reset \
     -H 'Content-Type: application/json' \
     -H 'Origin: http://localhost:3000' \
     -d '{"email":"admin@test.local","redirectTo":"/reset-password"}'
   ```

2. **Platform email verification** — endpoint `POST /api/auth/send-verification-email` (`email-verification.mjs:36`). BA no-ops if the user is already verified (`emailVerified: true`), so create a fresh user first via `POST /api/auth/sign-up/email` — `emailVerification.sendOnSignUp: true` on platform BA then triggers the verify callback automatically. Subject: `"Verify your Deliverse email"`. Event `data.instance === 'platform'`.

   ```bash
   curl -X POST http://localhost:3000/api/auth/sign-up/email \
     -H 'Content-Type: application/json' \
     -H 'Origin: http://localhost:3000' \
     -d '{"email":"smoke-verify@example.com","password":"SmokeVerifyPass-12","name":"Smoke Verify"}'
   ```

3. **Storefront password reset** — same BA endpoint, hit on a brand subdomain. Same enumeration-protection behavior, so create a storefront end-user first via `POST /api/auth/sign-up/email` against the subdomain (storefront has `autoSignIn: true`, no verification gate). Subject: `"Reset your password for Pizza Express"`. Event `data.instance === 'storefront'` with `tenantId` + `brandSlug = 'pizza-express'`.

   ```bash
   # 1. Sign up
   curl -X POST http://pizza-express.localhost:3001/api/auth/sign-up/email \
     --resolve pizza-express.localhost:3001:127.0.0.1 \
     -H 'Content-Type: application/json' \
     -H 'Origin: http://pizza-express.localhost:3001' \
     -d '{"email":"smoke-reset@example.com","password":"SmokeResetPass-12","name":"Smoke Reset"}'

   # 2. Reset
   curl -X POST http://pizza-express.localhost:3001/api/auth/request-password-reset \
     --resolve pizza-express.localhost:3001:127.0.0.1 \
     -H 'Content-Type: application/json' \
     -H 'Origin: http://pizza-express.localhost:3001' \
     -d '{"email":"smoke-reset@example.com","redirectTo":"/reset-password"}'
   ```

### 9c. DEL-6 Linear AC mapping (3-stub reality)

| AC | Verified by |
|---|---|
| #1 Spec | this file |
| #2 BA stubs replaced with Inngest events | §8 (3 stubs; AC text should be edited post-merge) |
| #3 Password-reset templates (platform neutral + storefront brand-themed) | §7 + Vitest |
| #4 Email-verification template (platform-only) | §7 + Vitest; AC text should be edited to drop the "storefront, brand-themed" half |
| #5 Integration tests both flows both apps | §9a unit tests + §9b API-driven curl smoke (3 flows, not 4). **Clickable browser UI for forgot-password / verify-email is DEL-7's scope** — DEL-6 proves the email pipeline; DEL-7 puts pages in front of it. |
| #6 Auth-spec §6 AC#3 + signup verification achievable | True after this ships |

## 10. Files touched

### New

- `docs/specs/transactional-emails.md` — this file.
- `packages/emails/src/templates/_styles.ts` — shared layout chrome.
- `packages/emails/src/templates/password-reset.tsx` — discriminated by `instance`.
- `packages/emails/src/templates/email-verify.tsx` — platform-only today.
- `packages/emails/src/handlers/password-reset-requested.ts` — pure handler with `switch(data.instance)`.
- `packages/emails/src/handlers/email-verification-requested.ts` — pure handler, single-arm switch for forward-compat.
- `packages/emails/src/inngest/password-reset.ts` + `email-verify.ts` — thin Inngest wrappers, `InngestFunction.Any` annotated.
- `packages/emails/__tests__/password-reset.test.ts` + `email-verify.test.ts` — Vitest unit tests, mirror `otp.test.ts`.

### Edit

- `packages/emails/src/events.ts` — add two new event schemas + types per §5.
- `packages/emails/src/templates/otp.tsx` — import shared chrome from `_styles.ts`; keep OTP-specific styles inline.
- `packages/emails/src/inngest/index.ts` — extend `functions` array with both new handlers.
- `packages/auth-core/src/storefront.ts` — replace `sendResetPassword` stub at `:131-133` per §8a.
- `packages/auth-core/src/platform.ts` — add `inngest` import; replace `sendResetPassword` (`:91-93`) + `sendVerificationEmail` (`:99-101`) per §8b.
- `AGENTS.md` — move DEL-6 to "Recently shipped (M1)".
- `docs/specs/email-delivery.md` §5 — strike the remaining "stays as `console.log` until DEL-6" pointers; link to this spec.
- `docs/decisions/0009-emails-package-shape.md` — optional Amendments note (two more events, shared chrome extraction, registry now lists 3 functions; still single registration).

## 11. Out of scope (deferred, with explicit owners)

- **Storefront non-OTP email verification** — would require setting `emailAndPassword.requireEmailVerification: true` on storefront BA (a product UX change: removes the current `autoSignIn` behavior). Separate issue if/when that's desired; this spec's schema accepts it as an additive change.
- **Email-change notification flow** — auth-spec §11.6; DEL-6 Linear non-goal.
- **Magic-link login** — auth-spec §7 explicit non-goal.
- **OTP rate limiting** → DEL-9.
- **Brand-specific `From:` addresses** → post-private-beta (per DEL-4 spec §13).
- **Custom retry tuning, dead-letter queue, template versioning** → defer until real failure modes surface.
- **New ADR** — install diff covered by ADR-0011; DEL-6 adds no new deps.

## 12. Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| `_styles.ts` extraction silently changes OTP template rendering | L | M | OTP unit test asserts `html.toContain('Pizza Express')` + 6-digit code; regression caught by CI. |
| Platform module-level `inngest.send()` has a side-effect-at-load issue | L | L | DEL-5's `client.ts` lazy-init fix already covers Resend; Inngest's `new Inngest({ id })` has no env-load side effect. |
| Future BA version changes the default TTL → "expires in 1 hour" copy goes stale | L | L | Spec cites the source line; future BA upgrade should re-check. Templates would change in that issue. |
| Linear AC #2 / #4 wording stays at "four stubs" + "storefront, brand-themed" | L | L | Edit AC post-merge to match shipped reality; spec §3 documents the divergence so reviewers can verify the call. |

## 13. Decisions log

| Date | Decision | Reasoning |
|---|---|---|
| 2026-05-26 | 3 stubs, not 4 (no storefront non-OTP email-verify) | DEL-4 §5 is locked source of truth; storefront BA has no `requireEmailVerification`; OTP `email_verify` type already covers storefront email-verify intent |
| 2026-05-26 | `emailVerificationRequestedEvent` kept as discriminated union despite single variant | Preserves DEL-4 §6 shape so future storefront variant is additive |
| 2026-05-26 | No `token` field in event payload | YAGNI + reduces sensitive-data surface; `url` already carries the actionable target |
| 2026-05-26 | Shared style chrome extracted to `_styles.ts` | Three templates is the right size to extract; OTP template refactor cheap + caught by tests |
| 2026-05-26 | Handlers switch on `data.instance` even when single-variant | Symmetric shape with password-reset handler; cheap forward-compat |
| 2026-05-26 | Reset + verification TTL copy cites "1 hour" (verified) | Confirmed from `password.mjs:64` + `email-verification.mjs:12`; our configs don't override |
| 2026-05-26 | Platform inngest imported at module level (no factory) | Platform BA already a top-level `betterAuth(...)` call; platform events carry no tenant context so no closure needed |
