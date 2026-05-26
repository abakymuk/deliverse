# OTP email — first real Inngest → Resend send (storefront)

**Status:** Draft
**Date:** 2026-05-26
**Owner:** Vlad
**Issue:** [DEL-5](https://linear.app/oveglobal/issue/DEL-5)
**Blocked by:** [DEL-4](https://linear.app/oveglobal/issue/DEL-4) ✓ (architecture lock), [DEL-3](https://linear.app/oveglobal/issue/DEL-3) ✓ (storefront tenant scoping)
**Builds on:** [`email-delivery.md`](./email-delivery.md), [`0009-emails-package-shape.md`](../decisions/0009-emails-package-shape.md), [`storefront-tenant-scoping.md`](./storefront-tenant-scoping.md)
**Unblocks:** [DEL-6](https://linear.app/oveglobal/issue/DEL-6) (password reset + email verify reuse this slice's pattern), [DEL-7](https://linear.app/oveglobal/issue/DEL-7) (non-OAuth signup needs working OTP)

---

## 1. Goal

Ship the **first real transactional email** in the workspace by replacing the storefront `sendVerificationOTP` `console.log` stub ([`packages/auth-core/src/storefront.ts:177-179`](../../packages/auth-core/src/storefront.ts)) with the full Inngest → Resend send path designed in DEL-4. End-user storefront login becomes possible end-to-end after this issue ships.

Concretely, fill in DEL-4's empty `packages/emails/` skeleton with the OTP-only slice:

- the Zod event schema (`email.otp.requested`),
- the Resend client wrapper,
- the package-local brand-context resolver,
- the React Email template,
- the pure `handleOtpRequested(data)` function + the thin Inngest function wrapping it,
- the platform app's `/api/inngest` route handler that registers the function.

DEL-6 will later add password-reset + email-verify on the same pattern.

## 2. Source of truth

- **DEL-4 architecture spec:** [`docs/specs/email-delivery.md`](./email-delivery.md) — locked. Decisions #1–#10 are non-negotiable.
- **ADR-0009:** [`docs/decisions/0009-emails-package-shape.md`](../decisions/0009-emails-package-shape.md) — package shape, dep direction, function-registration rule.
- **DEL-3 wrapper:** [`docs/specs/storefront-tenant-scoping.md`](./storefront-tenant-scoping.md) §5 — the factory-callback pattern this spec extends with one new field (§7).
- **The OTP stub:** [`packages/auth-core/src/storefront.ts:177-179`](../../packages/auth-core/src/storefront.ts) — the call site being replaced.
- **DEL-5 Linear AC:** spec written, BA hook emits Inngest event, function consumes + renders template + sends, failures retry per Inngest defaults, integration test against `pizza-express.localhost:3001` confirms branded send.
- **`.env.example`** lines 38-43 (Resend) + 56-60 (Inngest) — already documented in DEL-4; no `.env.example` change needed in DEL-5.

## 3. Scope framing — what's locked vs. what DEL-5 adds

DEL-4 closed every architectural question; this spec records the **build-time decisions** that surface only when wiring the first real send:

- the dep set actually resolved by `pnpm install` (captured in ADR-0011),
- the exact plumbing for `brandSlug` from request context into the OTP callback closure (§7 — the only structural addition),
- the test-surface split between the pure handler and the Inngest SDK wrapper (§6).

Everything else mirrors DEL-4's spec verbatim.

## 4. Decisions

| # | Decision | Rationale | Source |
|---|---|---|---|
| 1 | **OTP event only.** DEL-5 ships `email.otp.requested` + its handler + its template. The other two events (`email.password_reset.requested`, `email.email_verification.requested`) are deferred to DEL-6. | Per DEL-4 §9 "DEL-5 creates the first OTP slice (...); DEL-6 adds the two remaining flows." Smallest reviewable PR. | DEL-4 spec §9 |
| 2 | **React Email v6 dep split is real.** Install both `react-email` (CLI/preview) and `@react-email/components` (runtime imports) and `@react-email/render` (Resend SDK uses internally). The "unified single package" framing in ADR-0009 doesn't match what `pnpm install` actually resolves; templates `import { Html, Head, Body, ... } from '@react-email/components'`, **not** from `'react-email'`. | Documented react-email v6.0.0 packaging bug — scaffolded `import from 'react-email'` doesn't resolve. ADR-0011 captures the install reality. | [react-email#3414](https://github.com/resend/react-email/issues/3414) |
| 3 | **Pure-function handler + thin Inngest wrapper.** The business logic (parse → resolve brand → render → send) lives in `packages/emails/src/handlers/otp-requested.ts` as `handleOtpRequested(data)`. The Inngest function in `packages/emails/src/inngest/otp.ts` is a one-line wrapper: `step.run('send', () => handleOtpRequested(event.data))`. | The pure function is unit-testable without touching Inngest SDK internals. Tests stay stable across `inngest` SDK upgrades. | Plan-review feedback |
| 4 | **Resend wrapper dev no-op logs `{ to, subject }` only — no body preview.** The OTP template's body literally contains the 6-digit code; any preview risks leaking it regardless of caller-side `otp: '***'` redaction. | DEL-4 spec §8 left the redaction surface to the caller. Moving it wrapper-side closes the leak class entirely; future templates can never accidentally widen it. | Plan-review feedback; ADR-0009 decision #10 |
| 5 | **`brandSlug` plumbing — extend `StorefrontTenantContext`.** DEL-3 shipped `ResolveTenantContext: () => Promise<{ tenantId, brandId }>`. The OTP callback needs `brandSlug` for the Inngest event payload. We extend the context to `{ tenantId, brandId, brandSlug }`. Additive — the adapter wrapper ignores the new field. | The alternative (sibling `resolveEmailContext` callback) would double the resolver plumbing per request for zero benefit. The slug is already on `BrandContext.brand.slug` from `resolveBrandBySlug` ([`packages/auth-core/src/storefront-tenant-resolver.ts:20`](../../packages/auth-core/src/storefront-tenant-resolver.ts)). | See §7 |
| 6 | **`apps/storefront` does NOT add `inngest` as a direct dep.** ADR-0009 anticipated it as a runtime dep; that turns out to be wrong. All `inngest.send()` calls flow through `packages/auth-core` → `@rp/emails/inngest`. The storefront app inherits the symbol via re-export. | Minimum surface. ADR-0011 records the correction. | See §9 (Install diff) |
| 7 | **`@rp/auth-core` adds `@rp/emails: workspace:*` as a dep.** The storefront factory imports the `inngest` client from `@rp/emails/inngest`. The `inngest` SDK itself is a transitive of `@rp/emails`; auth-core does not declare it directly. | Same minimum-surface principle as #6. | n/a |

## 5. Event payload contract — `email.otp.requested`

Frozen by DEL-4 spec §6; restating here for grep-ability.

```ts
// packages/emails/src/events.ts
import { z } from 'zod';

// SENSITIVE: data.otp is plaintext — never log, never expose in error messages.
// ADR-0009 decision #10 classifies this as the security note.
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

export type OtpRequestedData = z.infer<typeof otpRequestedEvent>['data'];
```

DEL-6 will add `passwordResetRequestedEvent` + `emailVerificationRequestedEvent` (discriminated unions by `instance`). They are **not** scaffolded here — strict YAGNI.

## 6. Handler shape — pure function + thin Inngest wrapper

```ts
// packages/emails/src/handlers/otp-requested.ts (pure — unit-testable)
import { otpRequestedEvent, type OtpRequestedData } from '../events';
import { resolveEmailBrandContext } from '../brand-context';
import { sendEmail } from '../client';
import { OtpEmail } from '../templates/otp';

export async function handleOtpRequested(
  data: OtpRequestedData,
): Promise<{ id: string }> {
  otpRequestedEvent.shape.data.parse(data); // throws on schema violation
  const { brand, tenant } = await resolveEmailBrandContext(
    data.brandSlug,
    data.tenantId,
  );
  return sendEmail({
    to: data.email,
    subject: subjectFor(data.type, brand),
    react: OtpEmail({ brand, tenant, otp: data.otp, type: data.type }),
  });
}
```

```ts
// packages/emails/src/inngest/otp.ts (thin)
import { inngest } from './client';
import { handleOtpRequested } from '../handlers/otp-requested';

export const otpRequestedHandler = inngest.createFunction(
  { id: 'otp-requested' },
  { event: 'email.otp.requested' },
  async ({ event, step }) =>
    step.run('send', () => handleOtpRequested(event.data)),
);
```

Inngest's `step.run` wrapping is what gives us per-step retry + idempotency without us writing custom retry code (per DEL-4 spec §7, "Retry policy: Inngest defaults. Idempotency: Inngest's per-event idempotency keyed on `eventId`.").

## 7. `brandSlug` plumbing — `StorefrontTenantContext` extension

BA's `sendVerificationOTP` callback signature is `({ email, otp, type })` — it does **not** receive tenant context. DEL-3 already wired the storefront factory to close over `resolveTenantContext: () => Promise<{ tenantId, brandId }>`. The Inngest event needs `brandSlug` (not `brandId`).

**Change.** Extend the context type at [`packages/auth-core/src/storefront-adapter.ts:25-28`](../../packages/auth-core/src/storefront-adapter.ts) from:

```ts
export type StorefrontTenantContext = {
  tenantId: string;
  brandId: string;
};
```

to:

```ts
export type StorefrontTenantContext = {
  tenantId: string;
  brandId: string;
  brandSlug: string;
};
```

**Consumer.** [`apps/storefront/src/lib/storefront-tenant-context.ts:53-56`](../../apps/storefront/src/lib/storefront-tenant-context.ts) gains one line: `brandSlug: brandContext.brand.slug`. The slug is already on `BrandContext.brand.slug` — no extra DB call.

**The OTP callback** (replaces lines 177-179):

```ts
sendVerificationOTP: async ({ email, otp, type }) => {
  const ctx = await resolveTenantContext();
  await inngest.send({
    name: 'email.otp.requested',
    data: { email, otp, type, tenantId: ctx.tenantId, brandSlug: ctx.brandSlug },
  });
},
```

The adapter wrapper at [`storefront-adapter.ts:54-93`](../../packages/auth-core/src/storefront-adapter.ts) does NOT read `brandSlug`; the extension is additive and non-breaking. DEL-3's spec + ADR-0010 are amended in DEL-5's commit 5 (Amendments section) so the contract docs don't go stale.

## 8. Brand-context resolver — package-local, with tenant-ownership check

Per ADR-0009 §10: `packages/emails/src/brand-context.ts` exports `resolveEmailBrandContext(brandSlug, tenantId)` using `@rp/db` directly. It mirrors but does **NOT import** `resolveBrandBySlug` from [`packages/auth-core/src/storefront-tenant-resolver.ts:20`](../../packages/auth-core/src/storefront-tenant-resolver.ts) — the duplication is deliberate per ADR-0009 (emails resolver adds the tenant-ownership check, keeps the package self-contained).

```ts
// packages/emails/src/brand-context.ts
export class BrandResolutionError extends Error {
  constructor(reason: string) {
    super(`emails: brand resolution failed — ${reason}`);
  }
}

export async function resolveEmailBrandContext(
  brandSlug: string,
  tenantId: string,
): Promise<{ brand: Brand; tenant: Tenant }> {
  const result = await db
    .select({ brand: brands, tenant: tenants })
    .from(brands)
    .innerJoin(tenants, eq(brands.tenantId, tenants.id))
    .where(
      and(
        eq(brands.slug, brandSlug),
        isNull(brands.deletedAt),
        isNull(tenants.deletedAt),
        eq(tenants.status, 'active'),
        eq(brands.isActive, true),
      ),
    )
    .limit(1);

  const row = result[0];
  if (!row) {
    throw new BrandResolutionError(
      `no active brand for slug=${brandSlug}, tenantId=${tenantId}`,
    );
  }
  if (row.brand.tenantId !== tenantId) {
    throw new BrandResolutionError(
      `tenant ownership mismatch — brand "${brandSlug}" belongs to tenant ${row.brand.tenantId}, event claims ${tenantId}`,
    );
  }
  return row;
}
```

Thrown errors propagate up through `handleOtpRequested` → Inngest's default retry policy (4 retries, exponential backoff). After retries exhaust, the event lands in Inngest's failed-event view for manual triage.

## 9. Install diff (captured in [ADR-0011](../decisions/0011-emails-install-diff.md))

The DEL-4 ADR anticipated `inngest`, `resend`, `react-email`, `react`, `zod`, `@rp/db` for the emails package, and `inngest` for both apps. Actual diff in DEL-5:

- **`packages/emails/`**: `inngest`, `resend`, `react-email`, **`@react-email/components`** (new — runtime imports), **`@react-email/render`** (new — Resend SDK uses internally), `react`, `zod`, `@rp/db`. Plus `vitest` + `@types/react` (dev). `react-dom` is **not** installed unless `pnpm install` reports it as an unmet peer (`@react-email/render` ships its own SSR).
- **`apps/platform/`**: `inngest` (for `serve` from `inngest/next`) + **`@rp/emails: workspace:*`** (the route imports `inngest` + `functions` from `@rp/emails/inngest`).
- **`apps/storefront/`**: nothing. All `inngest.send()` calls flow through `@rp/auth-core` → `@rp/emails/inngest`.
- **`packages/auth-core/`**: **`@rp/emails: workspace:*`** (the factory imports the inngest client from `@rp/emails/inngest`). No direct `inngest` declaration — symbol comes through the re-export.

ADR-0011 records the actual resolved versions and the `apps/storefront` correction relative to ADR-0009's anticipated-dep list.

## 10. Resend client wrapper (DEL-4 spec §8, restated)

```ts
// packages/emails/src/client.ts
export type SendEmailArgs = {
  to: string;
  subject: string;
  react: React.ReactElement;
  text?: string;
};

export async function sendEmail(args: SendEmailArgs): Promise<{ id: string }> {
  // 1. Module-load env check:
  //    - NODE_ENV === 'production': RESEND_API_KEY + RESEND_FROM_EMAIL required, throw if missing.
  //    - dev/test: missing RESEND_API_KEY → no-op, log `[DEV] would send: { to, subject }`
  //      (NO body preview — OTP template body contains the code; preview would leak it).
  // 2. resend.emails.send({ from: RESEND_FROM_EMAIL, to, subject, react, text }).
  // 3. Normalize errors → throw `EmailSendError` with cause.
  // 4. Return { id } from Resend's response.
}
```

## 11. Verification

### 11.1 Automated (CI)

- [ ] `packages/emails/__tests__/otp.test.ts` — Vitest unit tests against `handleOtpRequested(data)`. Mock `@rp/db` (return Hospitality Group + Pizza Express fixtures) + `resend` (capture send args). Assertions:
  - Rendered HTML contains the 6-digit code and the brand name.
  - `sendEmail` called with `to`, `from = RESEND_FROM_EMAIL`, expected subject.
  - Negative: resolver tenant-ownership mismatch → `handleOtpRequested` propagates `BrandResolutionError`.
- [ ] `pnpm --filter @rp/emails test`, `pnpm typecheck`, `pnpm biome check` — green across workspace.

### 11.2 Manual local-dev (PR description checklist per AGENTS.md Phase 3)

```bash
# Terminal 1
pnpm dlx inngest-cli@latest dev

# Terminal 2
doppler run -- pnpm dev
```

1. Visit `http://pizza-express.localhost:3001/login`.
2. Enter a real email you control (use Resend's `onboarding@resend.dev` sandbox if no verified domain).
3. Click "Send code".
4. Check Inngest dev UI at `http://localhost:8288` — confirm `email.otp.requested` event fired and `otp-requested` function ran green.
5. Check Resend dashboard "Logs" tab — confirm email landed, `From: <RESEND_FROM_EMAIL>`, body branded as Pizza Express.
6. Repeat at `http://burger-heaven.localhost:3001/login` — confirm Burger Heaven branding renders (NOT Pizza Express).
7. With `RESEND_API_KEY` unset in `.env.local`, repeat (1)-(3) — confirm wrapper logs `[DEV] would send: { to, subject }` and the OTP does NOT appear in the log line.

### 11.3 DEL-5 Linear AC mapping

| AC | Verified by |
|---|---|
| #1 Spec written + reviewed + linked | this file |
| #2 `sendVerificationOTP` emits Inngest event | §7 + Vitest unit test |
| #3 Function renders brand-themed template + Resend send | §6 + Vitest unit test + manual step 5 |
| #4 Resend error → Inngest retry with backoff | Inngest default (4 retries exponential) — doc reference, not fault-injection-tested |
| #5 Integration test at `pizza-express.localhost:3001` real send | Manual step 5 |
| #6 Auth-spec §6 AC#4 (OTP path) achievable | true after this ships |

## 12. Files touched

### New

- `docs/specs/otp-email.md` — this file.
- `docs/decisions/0011-emails-install-diff.md` — captures install diff + react-email v6 split + storefront-app dep correction.
- `packages/emails/src/inngest/client.ts` — `new Inngest({ id: 'rp-emails' })`.
- `packages/emails/src/events.ts` — Zod schema (§5).
- `packages/emails/src/client.ts` — Resend wrapper (§10).
- `packages/emails/src/brand-context.ts` — resolver (§8).
- `packages/emails/src/handlers/otp-requested.ts` — pure handler (§6).
- `packages/emails/src/inngest/otp.ts` — thin Inngest wrapper (§6).
- `packages/emails/src/inngest/index.ts` — `export const functions = [otpRequestedHandler]; export { inngest } from './client'`.
- `packages/emails/src/templates/otp.tsx` — React Email template, imports from `@react-email/components`.
- `packages/emails/__tests__/otp.test.ts` — Vitest unit tests.
- `apps/platform/src/app/api/inngest/route.ts` — Next.js App Router route with `serve({ client, functions })`. `export const dynamic = 'force-dynamic'` + `export const maxDuration = 300`. No `runtime = 'edge'` (postgres is Node-only).

### Edit

- `packages/auth-core/src/storefront-adapter.ts:25-28` — extend `StorefrontTenantContext` with `brandSlug` (§7).
- `apps/storefront/src/lib/storefront-tenant-context.ts:53-56` — return `brandSlug`.
- `packages/auth-core/src/storefront.ts:177-179` — replace `console.log` with `inngest.send` (§7).
- `packages/auth-core/src/storefront.ts` (top) — `import { inngest } from '@rp/emails/inngest'`.
- `packages/emails/package.json` — add deps (§9), add `test` + `typecheck` scripts.
- `apps/platform/package.json` — add `inngest` + `@rp/emails: workspace:*`.
- `packages/auth-core/package.json` — add `@rp/emails: workspace:*`.
- `pnpm-lock.yaml` — regenerated.
- `AGENTS.md` — move DEL-5 to "Recently shipped"; add Inngest-route gotcha.
- `docs/specs/email-delivery.md` — strike "stays as `console.log`" reference in §5; link to this spec.
- `docs/decisions/0009-emails-package-shape.md` — amend "Anticipated deps" with the react-email v6 reality + storefront-app correction; cross-link ADR-0011.
- `docs/specs/storefront-tenant-scoping.md` — amend §5.3 to include `brandSlug` in the context shape.
- `docs/decisions/0010-tenant-scoping-injection.md` — append an "Amendments" section noting DEL-5's `brandSlug` addition.

## 13. Out of scope (deferred, with explicit owners)

- **DEL-6** — password-reset + email-verify templates + handlers + event schemas. Same pattern, scaffolded later.
- **DEL-9** — OTP rate limiting / cooldown.
- **DEL-12** — OAuth account-table tenant scoping (unrelated; blocks DEL-7 OAuth).
- Brand-specific `From:` addresses (`noreply@<brand>.deliverse.app`) — needs per-brand DNS verification; post-private-beta.
- Custom retry tuning, dead-letter queue, template versioning — defer until real failure modes surface.
- IP-based rate limiting on the `/api/inngest` route — edge concern, v1 out-of-scope.
- CI-side Inngest dev server (port 8288) — layer-2 integration test stays manual per AGENTS.md "Definition of Done" #5.

## 14. Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| `@react-email/components` install introduces an unforeseen peer-dep cascade | M | L | ADR-0011 captures the resolved set; if cascade is large, revisit in a follow-up |
| OTP plaintext sits in Inngest event store for ~24h retention | confirmed | L | Accepted in ADR-0009 decision #10; revisit if Inngest retention becomes a concern |
| `dynamic = 'force-dynamic'` missing on `/api/inngest` route → static optimization → missed invocations | L | H | AGENTS.md gotcha added in commit 5; route file ships with the export from day 1 |
| `runtime = 'edge'` on the route would break (postgres is Node-only) | L | H | Spec explicitly forbids; reviewer must catch |
| Doppler `RESEND_API_KEY` / `INNGEST_*` not set in stg/prd before promotion | M | H | DEL-4 spec §11a prerequisites; PR description includes the env-check checklist |

## 15. Decisions log

| Date | Decision | Reasoning |
|---|---|---|
| 2026-05-26 | Pure-function handler split from Inngest SDK wrapper | Plan-review feedback — keep tests free of SDK-internals coupling |
| 2026-05-26 | Resend wrapper dev no-op logs `{ to, subject }` only (no body preview) | Plan-review feedback — moves OTP-leak prevention from caller-side to wrapper-side |
| 2026-05-26 | Extend `StorefrontTenantContext` with `brandSlug` instead of adding a sibling resolver | Single resolver per request; additive non-breaking type change; slug already on `BrandContext.brand` |
| 2026-05-26 | `apps/storefront` does NOT get a direct `inngest` dep | Auth-core is the only sender; storefront inherits via re-export. Corrects ADR-0009 anticipated-dep |
| 2026-05-26 | `react-dom` not installed unless `pnpm install` reports an unmet peer | `@react-email/render` ships its own SSR; ADR-0011 records the actual resolved set if differs |
