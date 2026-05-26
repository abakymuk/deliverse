# 0009 — Email delivery via `packages/emails/`: React Email + Inngest + Resend

**Date:** 2026-05-26
**Status:** Accepted
**Deciders:** Vlad

## Context

[DEL-4](https://linear.app/oveglobal/issue/DEL-4) needs to close the architecture question for how the workspace sends transactional emails. Today the four BA stub call sites — `emailAndPassword.sendResetPassword` (platform + storefront), `emailVerification.sendVerificationEmail` (platform), `emailOTP.sendVerificationOTP` (storefront) — are stubbed as `console.log` in `packages/auth-core/src/{platform,storefront}.ts`. AGENTS.md "Never Do" bans fire-and-forget side effects in request handlers, so the send path must go through Inngest. AGENTS.md also already commits to Resend as the deliverability provider.

The open questions left after those constraints are: where templates live (one shared package vs. co-located in each app), which template engine to use, what the Inngest event payloads look like, and where the Inngest functions are registered. The companion spec [`docs/specs/email-delivery.md`](../specs/email-delivery.md) is the implementation reference; this ADR records the architectural calls and their alternatives.

This is a **decision issue — DEL-4 ships no app code**. Implementation lands in [DEL-5](https://linear.app/oveglobal/issue/DEL-5) (OTP) and [DEL-6](https://linear.app/oveglobal/issue/DEL-6) (password reset + email verify).

## Decision

1. **New workspace package `packages/emails/`** — templates, the Resend wrapper, Zod event schemas, the package-local brand-context resolver, and the Inngest functions all live together. Both apps import from `@rp/emails` for type-safe event triggering.
2. **Template engine: React Email** — specifically the unified `react-email` package (v6+), which folded the previously-split `@react-email/components` + `@react-email/render` into one. JSX templates compile to inline-styled HTML at send time. (Sources: React Email Resend integration docs; React Email 6 changelog.)
3. **Domain-shaped Inngest events** — `email.otp.requested`, `email.password_reset.requested`, `email.email_verification.requested`. NOT a generic `email.send` with switch-on-template. Zod discriminated unions enforce `tenantId` + `brandSlug` as type-level requirements when `instance: 'storefront'`.
4. **Brand data is re-fetched in the handler**, not denormalized into the payload. The event carries identifiers (`tenantId`, `brandSlug`); the handler calls a **package-local** `resolveEmailBrandContext(brandSlug, tenantId)` that uses `@rp/db` directly and verifies `brand.tenantId === event.tenantId` for cross-tenant defense.
5. **Inngest functions register in exactly one place — `apps/platform/src/app/api/inngest/route.ts`**. Both apps' `inngest` clients call `inngest.send(...)`, but only the platform app hosts the function definitions. Inngest events fan out to all matching registered functions; double-registration would cause duplicate sends. (Sources: Inngest events / function-registration docs.)
6. **Thin Resend client wrapper** — `sendEmail({ to, subject, react, text? })` in `packages/emails/src/client.ts`. No retry logic at this layer (Inngest handles retries at the function layer). No-ops in dev when `RESEND_API_KEY` is missing, throws in prod.
7. **Single global `RESEND_FROM_EMAIL` for v1.** Brand-specific sender domains require per-brand DNS verification (SPF/DKIM/DMARC); deferred to post-private-beta.

## Alternatives Considered

- **Co-located templates per app** (no `packages/emails/`). Rejected: duplicates the React Email + Resend setup across both apps and splits the Inngest function registry. `packages/auth-core/` set the precedent for shared auth-adjacent code; emails follow the same pattern.
- **Generic `email.send` event** with `{ template, recipient, data }` payload and a single handler that switches on template. Rejected: couples all flows together, makes per-flow versioning awkward, and loses the type-level guarantee that storefront flows carry `tenantId` + `brandSlug`.
- **MJML** as the template language. Rejected: separate template language with its own compile step (or runtime cost), adds an `mjml` dep, and is overkill for three templates. React Email gives us cross-client-compatible HTML with the JSX vocabulary we already use everywhere.
- **Plain HTML template literals** — functions returning strings. Rejected: hand-rolled inline styling for cross-client compatibility (Outlook, Gmail apps) is exactly the problem React Email solves. Brand-color/logo composition becomes string concat; reuse across templates is awkward.
- **Bull / BullMQ / Trigger.dev** as the queue. Rejected: AGENTS.md already commits to Inngest as the workspace's async runtime. Switching queues belongs in its own ADR with its own context.
- **Denormalize brand data into the event payload** (`{ brandName, brandLogo, brandColor, tenantName, ... }` baked into the event). Rejected: stale-data risk if branding changes between request and send; event payloads bloat and become harder to grep. One extra DB roundtrip per send is negligible.
- **Register Inngest functions from both apps' `/api/inngest` routes**. Rejected: Inngest's fan-out semantics would cause duplicate sends. Per-event idempotency dedupes duplicate events, NOT duplicate function registrations.
- **Import `apps/storefront/src/lib/tenant-resolution.ts:getBrandContext` from the package**. Rejected: workspace dep direction forbids packages depending on apps, and that helper uses Next.js's React `cache()` which doesn't make sense in an Inngest worker. The package-local resolver also adds the tenant-ownership check, which is a defense-in-depth win the storefront helper doesn't carry.

## Consequences

### Positive

- Single source of truth for templates + send machinery; no per-app duplication.
- Type-safe events: the Zod discriminated union catches `instance: 'storefront'` callers missing `tenantId`/`brandSlug` at compile time, not runtime.
- Brand reuse: a single `<BrandHeader brand={brand} tenant={tenant} />` JSX component composes into every storefront template.
- Inngest upgrades become a `pnpm up inngest` in one place + a function-registration smoke; the BA configs don't know Inngest exists.
- Template versioning is a future option (Inngest functions are versioned via function IDs and event names).

### Negative

- React Email pulls in ~30 transitive deps. Acceptable cost for the deliverability + brand-reuse wins; documented as part of the package's first install in DEL-5.
- First contributor to a template needs to learn React Email's component vocabulary (`<Html>`, `<Head>`, `<Body>`, `<Container>`, `<Section>`, `<Text>`, `<Button>`, etc.). Mitigated by Resend's well-documented integration and React Email's online preview tool.
- The package-local `resolveEmailBrandContext` duplicates a slice of the storefront's brand-resolution logic. Acceptable to avoid the dep-direction violation; if the duplication ever drifts, a shared `packages/db/src/queries/brands.ts` is the next move.

### Neutral

- Inngest functions register from ONE place. New developers reading `apps/storefront/src/app/api/inngest/route.ts` (if they look there first) need to know the registry lives on the platform side. Documented in the spec §5 and §11.
- OTP plaintext is sensitive in the Inngest event payload. Inngest retention is the second source of OTP exposure (DB is hashed per DEL-11); spec §10 calls this out as the explicit security note, with the codified ban on logging the field.

## Future implications

- **Brand-specific sender domains** (`noreply@pizza-express.deliverse.app`) — add a per-brand `branding.fromEmail` column to the `brands` table, verify each in Resend, and have the resolver return the right from-address. Out of scope until private beta.
- **Dead-letter handling** — Inngest's failed-event view is the v1 substitute; if it grows beyond what we can hand-triage, wire a `email.send.failed` event to a Slack channel.
- **Template versioning** — when a template's copy needs rollback, version the function (`otpRequestedHandler.v2`) and route the event via Inngest's version-aware routing.
- **Cross-channel sends** (SMS via Twilio, push notifications) — same package shape, different channel client. The Inngest event names would gain channel suffixes (`otp.email.requested` vs `otp.sms.requested`).

## Anticipated deps (installed by DEL-5 / DEL-6, not DEL-4)

- `packages/emails/`: `inngest`, `resend`, `react-email` (v6 unified), `react`, `zod`, `@rp/db` (workspace).
- `apps/platform`: `inngest` (same version), for triggering events + hosting `/api/inngest`.
- `apps/storefront`: `inngest` (same version), for triggering events only.

The actual install in DEL-5 may reveal subtleties (peer deps, version constraints) that override this list — when that happens, this ADR is updated to match reality, mirroring how ADR-0008 was written *after* the shadcn CLI diff.

## References

- [DEL-4 issue](https://linear.app/oveglobal/issue/DEL-4)
- [docs/specs/email-delivery.md](../specs/email-delivery.md) — implementation spec.
- [docs/auth-spec.md](../auth-spec.md) §12 — OTP security posture.
- [AGENTS.md](../../AGENTS.md) — "Never Do" (fire-and-forget) + boring-tech table (Inngest + Resend).
- [`.env.example`](../../.env.example) lines 38-43 (Resend) + 56-60 (Inngest) — env vars already documented.
- [Resend + React Email integration](https://resend.com/docs/send-with-react-email).
- [React Email 6 changelog](https://react.email/docs/migration-guide).
- [Inngest events docs](https://www.inngest.com/docs/events).
- [Inngest function registration / serve handlers](https://www.inngest.com/docs/learn/serving-inngest-functions).
- [ADR-0002](./0002-better-auth-vs-clerk.md) — auth choice (BA is the trigger for the send hooks).
- [ADR-0008](./0008-shadcn-and-form-deps.md) — same "write the ADR against the actual CLI diff" pattern this issue inherits.
