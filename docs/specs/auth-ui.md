# Auth UI — signup + forgot/reset-password + cross-brand disclosure

**Status:** Draft
**Date:** 2026-05-26
**Owner:** Vlad
**Issue:** [DEL-7](https://linear.app/oveglobal/issue/DEL-7)
**Blocked by:** [DEL-2](https://linear.app/oveglobal/issue/DEL-2) ✓ (form primitives), [DEL-3](https://linear.app/oveglobal/issue/DEL-3) ✓ (storefront adapter), [DEL-5](https://linear.app/oveglobal/issue/DEL-5) ✓ (OTP email), [DEL-6](https://linear.app/oveglobal/issue/DEL-6) ✓ (reset/verify email)
**Builds on:** [`ui-foundations.md`](./ui-foundations.md) (Field pattern), [`storefront-tenant-scoping.md`](./storefront-tenant-scoping.md) (tenant resolver), [`transactional-emails.md`](./transactional-emails.md) (email pipeline), [`auth-spec.md`](../auth-spec.md) §6 + §10
**Unblocks:** [DEL-8](https://linear.app/oveglobal/issue/DEL-8) (E2E in CI; cross-brand disclosure spec is now unskippable)

---

## 1. Goal

Put clickable UI in front of every auth surface the email pipeline already supports. After DEL-7 ships, end users + platform staff can complete signup, password reset, and (storefront) email verification entirely through the browser — no curl, no SQL. The 4 BA callbacks DEL-5 + DEL-6 wired finally have user-visible front doors.

## 2. Source of truth

- **DEL-2 form pattern:** [`ui-foundations.md`](./ui-foundations.md) §6 — `<FieldGroup>` + `<Field>` + `<FieldLabel>` + `<FieldError>` + RHF `useForm` + `zodResolver` + `Controller`. Canonical example: [`apps/storefront/src/components/auth/login-form.tsx`](../../apps/storefront/src/components/auth/login-form.tsx) (~158 lines).
- **DEL-3 storefront layout:** [`apps/storefront/src/app/(auth)/layout.tsx`](../../apps/storefront/src/app/(auth)/layout.tsx) — already resolves `x-brand-slug` → `getBrandContext(slug)` → renders branded header + "Part of {Tenant.name}". Free header for every storefront auth page.
- **DEL-5/DEL-6 email pipeline:** `email.otp.requested`, `email.password_reset.requested`, `email.email_verification.requested` events all fire end-to-end and produce real Resend sends. The forms in this spec are the new HTTP callers of those callbacks.
- **BA installed-source line citations** (verified at spec time):
  - `packages/auth-core/node_modules/better-auth/dist/api/routes/password.mjs:60-118` — `requestPasswordReset({ email, redirectTo })` → constructs `${baseURL}/reset-password/<token>?callbackURL=<redirectTo>`. Line 115 throws `INVALID_TOKEN` if `callbackURL` is empty. The `redirectTo` field is **mandatory** in practice.
  - `email-verification.mjs:268,288` — after `/verify-email?token=...` validates, BA auto-signs-in (when `autoSignInAfterVerification: true`) and redirects to `callbackURL`.
  - `crud-invites.mjs:222-304,247` — `organization.acceptInvitation({ invitationId })` requires existing session + `emailVerified === true`. The flow is necessarily two-step: signUp → verify → autoSignIn → acceptInvitation.
  - `crud-invites.mjs:122` — invitation TTL defaults to 48 hours (`invitationExpiresIn || 3600 * 48`). Platform BA doesn't override.
- **`docs/auth-spec.md` §6** — AC#1, #2, #10 are what this issue closes. §10 cross-brand recognition disclosure copy.
- **DEL-12 boundary:** storefront OAuth signup is gated until [DEL-12](https://linear.app/oveglobal/issue/DEL-12) closes the `(provider_id, account_id)` global-uniqueness gap. Login already works for existing OAuth users; signup would create violating rows. **Storefront signup is OTP-only in DEL-7.**

## 3. Scope reconciliation

[DEL-7 Linear AC](https://linear.app/oveglobal/issue/DEL-7) is narrower than what this spec ships: only signup pages + cross-brand disclosure. Expanded post-DEL-6 to include forgot/reset-password pages on both apps (you said "DEL-7 owns the full clickable auth UX" after the DEL-6 forgot-password 404 surfaced). Verify-email needs no custom page — BA's `/api/auth/verify-email` route handles the token + redirects to `callbackURL`.

Net surface relative to Linear AC: **+4 pages, +4 forms** (forgot/reset × 2 apps). Edit Linear AC #2/#4 post-merge to match.

## 4. Decisions

| # | Decision | Rationale / source |
|---|---|---|
| 1 | **Cross-brand disclosure: always-on inline** on storefront signup. Shows the tenant's sibling brands as supportive copy. NOT conditional on email lookup. | `auth-spec.md` §10 is GDPR/trust copy, not personalization. Email-lookup would expose enumeration surface within tenant. The §10 "Welcome back!" verify-otp personalization is **deferred to a follow-up**. |
| 2 | **Reset-password URL via `redirectTo: '/reset-password'`**. Forgot-password forms pass it; BA constructs `${baseURL}/reset-password/<token>?callbackURL=/reset-password`, validates the token at GET, redirects to `/reset-password?token=<token>`. The reset-password page reads `?token=` from `searchParams` and POSTs `{ newPassword, token }` via the client SDK. | `password.mjs:60-118` (verified). Updates DEL-6's curl smoke recipes (which used `/dashboard` / `/` and would land users on the wrong page after BA's redirect). |
| 3 | **Platform verify-email landing: `callbackURL=/dashboard?accept=<invitationId>`**. After BA auto-signs-in (`autoSignInAfterVerification: true`), the user lands on `/dashboard`. A client-side accept-invitation hook reads `?accept=<id>` and calls `organization.acceptInvitation({ invitationId })`, then strips the query. | Without the hook, signup users have no tenant membership row → broken end-to-end UX. `useSearchParams()` lives in a client component because Next 16 server layouts don't receive `searchParams` (only pages do). |
| 4 | **Storefront signup is OTP-only.** Google button omitted from signup form (still on login form — pre-existing surface, not regressed). | DEL-12 hasn't tenant-scoped storefront OAuth accounts table. Login is safe for existing OAuth users; signup would violate `(provider_id, account_id)` global uniqueness. |
| 5 | **Invitation email wiring deferred to follow-up issue.** DEL-7 ships the signup form that consumes `?token=<invitationId>`; invitation URLs constructed manually (curl / future admin dashboard). | Same shape as DEL-6's transactional emails (~300 lines). Outside DEL-7's already-expanded scope. Follow-up DEL ticket filed when this PR opens. |
| 6 | ~~**No `checkEmailExistsInTenant` helper.**~~ DEL-14 added it for the `/verify-otp` welcome-back surface (§5e amendment). Signup-side cross-brand disclosure remains brand-context-driven via `getSiblingBrands`. | DEL-14 closed the deferred personalization. |
| 7 | **Platform invite-accept is a two-step flow.** `signUp.email` → BA fires verify email → user clicks link → BA verifies + autoSignIn → dashboard accept hook calls `acceptInvitation`. The form cannot pass name/password to `acceptInvitation` directly. | `crud-invites.mjs:222-304,247` — BA requires an existing session + `emailVerified === true` before allowing invitation acceptance. |
| 8 | **Storefront signup threads `name` via query.** BA's `emailOtp.sendVerificationOtp({ email, type })` ignores name; only `signIn.emailOtp({ email, otp, name })` uses it (when creating a first-time user). Signup form redirects to `/verify-otp?email=...&name=...&signup=true`; verify-otp form passes the query-`name` into the verify call. | Without this, storefront signups land with `name === null` in the DB. |
| 9 | **`authClient.requestPasswordReset(...)` / `.resetPassword(...)` called directly off the auth-client instance.** Current `apps/{platform,storefront}/src/lib/auth-client.ts` destructures only `signIn`, `signUp`, `signOut`, etc. Either destructure the reset methods too, or call via `authClient.xxx()`. Pick whichever is more consistent with the existing codebase at implementation time. | Avoids over-eager export expansion; same effect either way. |

## 5. Page-by-page

### 5a. Platform `/signup?token=<invitationId>`

- Reads `?token=` (= `invitationId`) from `searchParams`.
- Form: `{ email, password, name }`. Email + password use BA defaults (min 12 char password per `platform.ts:88`).
- Calls `signUp.email({ email, password, name, callbackURL: '/dashboard?accept=<token>' })`.
- BA's `sendOnSignUp: true` (`platform.ts:97`) fires `email.email_verification.requested` → DEL-6 handler → Resend sends the verify-email.
- User clicks link → BA verifies + autoSignIn → redirects to `/dashboard?accept=<token>` → accept hook finalizes.
- If `token` is missing from the URL, page renders an error state ("Invitation required — please use the link from your invitation email").

### 5b. Platform `/forgot-password`

- Form: `{ email }`.
- Calls `authClient.requestPasswordReset({ email, redirectTo: '/reset-password' })`.
- Success copy is **enumeration-safe** regardless of whether the email exists: "If an account exists for that email, we've sent a link to reset the password. Check your inbox."

### 5c. Platform `/reset-password?token=...`

- Reads `?token=` from `searchParams`.
- Form: `{ newPassword, confirmPassword }` (zod refine for confirm match).
- Calls `authClient.resetPassword({ newPassword, token })`.
- On success: `router.push('/login?reset=success')`.
- If token is invalid/expired, BA returns an error → form shows "This link is no longer valid. Please request a new one."

### 5d. Storefront `/signup` (subdomain-scoped)

- Server-component page reads `x-brand-slug` from `headers()`, calls `getBrandContext(slug)`, calls `getSiblingBrands(tenant.id, brand.slug)`.
- Renders `<CrossBrandDisclosure brand tenant siblingBrands />` (always, if `siblingBrands.length > 0`).
- Form: `{ email, name }`.
- Calls `emailOtp.sendVerificationOtp({ email, type: 'sign-in' })`. BA's emailOTP plugin creates the user lazily on verify (per `disableSignUp: false`, `storefront.ts:176`).
- Redirects to `/verify-otp?email=<email>&name=<name>&next=/account&signup=true` — `name` threaded so verify step can pass to BA.

### 5e. Storefront `/verify-otp` (existing — extended)

- Existing page reads `?email=` and `?next=`. Already wraps in `<Suspense>`.
- **DEL-7 extension:** read `?name=` and `?signup=true` too. If `signup === 'true'` AND `name` is present, pass `name` to `signIn.emailOtp({ email, otp, name })`. BA uses `name` only when creating a first-time user.
- **DEL-14 extension (cross-brand welcome-back):** page becomes a server component. Reads `x-brand-slug` header → `getBrandContext(slug)` → tenant + brand. Reads `?email=` from `searchParams`. Runs two DB lookups in parallel:
  - `checkEmailExistsInTenant(tenant.id, email)` — does the email already have an account in this tenant?
  - `hasUserVisitedBrand(tenant.id, email, brand.id)` — does the user have any prior session at the **current** brand?
  - **Welcome-back condition:** `emailExists && !visitedCurrentBrand`. This is the literal AC#3 interpretation: "the brand they're on now != the one they previously signed up at" — if the user has any account in the tenant but no session at the current brand, they're crossing brands for the first time on this device.
  - Page passes `{ welcomeBack, brandName, tenantName }` props to `<VerifyOtpForm />`. Form stays a client component for `useForm`/`useSearchParams`; new props are server-derived and stable for the page render.
- **Copy** (auth-spec §10 line 175): when `welcomeBack` is true, the form's `CardDescription` reads "Welcome back! We've sent a code to {email}. ({Brand Name} is part of {Tenant Name}'s family of brands — your account works here too.)" Default copy ("We sent a 6-digit code to {email}") stays for all other cases.
- **Privacy posture:** the in-tenant enumeration surface is bounded — only users who already have an account in this tenant see the welcome-back copy. The default copy is identical regardless of email-existence, so an attacker probing emails learns nothing new vs the existing OTP-send path (which already lazily creates users via BA's emailOTP plugin). Per auth-spec §10 "Do NOT": we never auto-populate name/preferences from the sibling-brand account.

### 5f. Storefront `/forgot-password`

- Same shape as 5b. Form calls `authClient.requestPasswordReset({ email, redirectTo: '/reset-password' })`.

### 5g. Storefront `/reset-password?token=...`

- Same shape as 5c.

## 6. Cross-brand disclosure component

```tsx
// apps/storefront/src/components/brand/cross-brand-disclosure.tsx
type Props = {
  brand: Brand;
  tenant: Tenant;
  siblingBrands: Brand[];
};

// Renders only if siblingBrands.length > 0.
// Copy (auth-spec §10 family-of-brands):
//   "<brand.name> is part of <tenant.name>'s family of brands
//    (<sibling names joined with ', '>).
//    Your account works at all of them."
```

Styled as a muted info card above the form (no border emphasis, friendly tone). The `(auth)/layout.tsx` already renders the tenant name in the header — this component is **additive**: it lists the sibling brands explicitly.

## 7. `cross-brand.ts` helpers

```ts
// apps/storefront/src/lib/cross-brand.ts
export async function getSiblingBrands(
  tenantId: string,
  currentBrandSlug: string,
): Promise<Brand[]>;

// DEL-14
export async function checkEmailExistsInTenant(
  tenantId: string,
  email: string,
): Promise<boolean>;

// DEL-14
export async function hasUserVisitedBrand(
  tenantId: string,
  email: string,
  brandId: string,
): Promise<boolean>;
```

- `getSiblingBrands`: queries `brands` where `tenantId = $1 AND slug != $2 AND deletedAt IS NULL AND isActive = true`. Returns empty array if no siblings.
- `checkEmailExistsInTenant`: queries `tenant_end_users` where `tenantId = $1 AND email = $2 AND deletedAt IS NULL`. Returns boolean (LIMIT 1 + presence check).
- `hasUserVisitedBrand`: joins `tenant_end_users` → `tenant_end_user_sessions` where `tenantId = $1 AND email = $2 AND deletedAt IS NULL AND currentBrandId = $3`. Returns boolean (LIMIT 1 + presence check). Sessions older than `expiresIn` (30d, see `storefront.ts`) may be cleaned up — this is a low-precision signal for "user has been here recently" which is acceptable for the welcome-back UX trade-off (over-triggering on returning users with expired sessions is benign).

All three follow the same Drizzle `select().from(...).where(...)` style as `packages/emails/src/brand-context.ts`. Unit tests mirror `packages/emails/__tests__/brand-context.test.ts`'s mock pattern (mock `@rp/db` at the module boundary, assert where-clause semantics).

## 8. Accept-invitation hook

```tsx
// apps/platform/src/components/auth/accept-invitation-hook.tsx — client component
'use client';
export function AcceptInvitationHook() {
  const params = useSearchParams();
  const accept = params.get('accept');
  const router = useRouter();
  useEffect(() => {
    if (!accept) return;
    organization
      .acceptInvitation({ invitationId: accept })
      .catch(/* swallow "already accepted" / "already member" non-fatally; log */)
      .finally(() => router.replace('/dashboard'));
  }, [accept, router]);
  return null;
}
```

Mounted inside `<Suspense>` on `dashboard/layout.tsx` (or `dashboard/page.tsx`). **Do not** assume BA's `acceptInvitation` swallows already-accepted invitations silently — catch the response, log, and continue.

## 9. Verification

### 9a. Automated (CI)

- `pnpm --filter @rp/storefront test` — adds `cross-brand.test.ts` (~5 cases mirroring `packages/emails/__tests__/brand-context.test.ts`).
- `pnpm -r typecheck` — green across workspace.
- `pnpm exec biome check` on touched files — green.
- `pnpm --filter @rp/storefront test:e2e` — unskipped cross-brand disclosure test passes (seed has Hospitality Group + pizza-express + burger-heaven per `packages/db/src/seed.ts`).

### 9b. Manual local-dev (PR description checklist)

Setup same as DEL-5/DEL-6: `pnpm dlx inngest-cli@latest dev` + `doppler run --config dev -- env -u INNGEST_EVENT_KEY -u INNGEST_SIGNING_KEY INNGEST_DEV=1 pnpm dev`.

1. **Platform signup-via-invite (end-to-end)** — manually construct an invite (SQL insert into `tenant_invitations` or one-off `organization.createInvitation` call). Visit `localhost:3000/signup?token=<id>` → fill email/password/name → submit → see `[DEV] would send: { to, subject: "Verify your Deliverse email" }` in platform terminal → curl the inngest event payload to grab the verify URL → visit it → BA verifies + autoSignIn + redirects to `/dashboard?accept=<id>` → accept hook calls `acceptInvitation` → URL strips back to `/dashboard`. End state: `platform_users` row + `tenant_memberships` row exist.
2. **Platform forgot-password roundtrip** — visit `localhost:3000/forgot-password` → enter `admin@test.local` → submit → enumeration-safe success copy → check `[DEV] would send: { to, subject: "Reset your Deliverse password" }` log → copy `url` from Inngest event payload → visit `<url>` → BA redirects to `/reset-password?token=...` → enter new password → submit → redirect `/login?reset=success` → sign in with new password.
3. **Storefront signup with cross-brand disclosure** — visit `pizza-express.localhost:3001/signup` → confirm disclosure copy "Pizza Express is part of Hospitality Group's family of brands (Burger Heaven). Your account works at all of them." → enter email + name → submit → redirected to `/verify-otp?email=<email>&name=<name>&next=/account&signup=true` (name in query is part of the signup contract) → check `[DEV] would send: { to, subject: "Your sign-in code for Pizza Express" }` → enter OTP → land on `/account`. Visit `burger-heaven.localhost:3001/signup` next: disclosure mentions Pizza Express as the sibling.
4. **Storefront forgot-password roundtrip** — same as platform but at `pizza-express.localhost:3001/forgot-password` for a previously-signed-up storefront user. Subject reads "Reset your password for Pizza Express". The reset URL origin is the brand subdomain (`pizza-express.localhost:3001/...`), not the platform host — see [DEL-15](https://linear.app/oveglobal/issue/DEL-15) + [`del-15-storefront-baseurl.md`](./del-15-storefront-baseurl.md).

### 9c. DEL-7 Linear AC mapping (expanded-scope reality)

| AC | Verified by |
|---|---|
| #1 Spec | this file |
| #2 Platform invite-token signup | §5a + manual flow 1 (AC text should be edited post-merge to mention forgot/reset pages also covered) |
| #3 Storefront OTP signup | §5d + manual flow 3 |
| #4 Cross-brand disclosure | §6 + manual flow 3 (AC text should drop the email-lookup framing — always-on per §4 decision #1) |
| #5 Tenant isolation negative test | E2E spec (unskipping the cross-tenant test gated on DEL-8 multi-tenant seed) |
| #6 Auth-spec §6 AC #1/#2/#10 hold | true after this ships |

## 10. Files touched

### New

- `docs/specs/auth-ui.md` — this file.
- `apps/storefront/src/lib/cross-brand.ts` + `__tests__/cross-brand.test.ts` — helper + tests.
- `apps/platform/src/app/(auth)/{signup,forgot-password,reset-password}/page.tsx` — 3 pages.
- `apps/platform/src/components/auth/{signup,forgot-password,reset-password}-form.tsx` — 3 forms.
- `apps/platform/src/components/auth/accept-invitation-hook.tsx` — client-component accept hook.
- `apps/storefront/src/app/(auth)/{signup,forgot-password,reset-password}/page.tsx` — 3 pages.
- `apps/storefront/src/components/auth/{signup,forgot-password,reset-password}-form.tsx` — 3 forms.
- `apps/storefront/src/components/brand/cross-brand-disclosure.tsx` — disclosure component.

### Edit

- `apps/storefront/src/components/auth/verify-otp-form.tsx` — thread `?name` + `?signup=true` from query into `signIn.emailOtp({ email, otp, name })`.
- `apps/platform/src/app/dashboard/{layout,page}.tsx` — mount `<AcceptInvitationHook />` inside `<Suspense>`.
- `apps/storefront/tests/e2e/auth.spec.ts` — unskip cross-brand disclosure test (line 40).
- `AGENTS.md` + `apps/{platform,storefront}/AGENTS.md` — move DEL-7 to Recently shipped; drop DEL-7-pending mentions.
- `docs/auth-spec.md` §9 — mark routes shipped; note "Welcome back!" personalization deferred.
- `docs/specs/transactional-emails.md` §9b — update `redirectTo` smoke recipes to `/reset-password`.

## 11. Out of scope (deferred, with explicit owners)

- **Invitation email wiring** (`email.invitation.requested` event + handler + template + BA `sendInvitationEmail` callback) — follow-up DEL ticket filed when this PR opens. Same shape as DEL-6.
- ~~**Cross-brand "Welcome back!" personalization on `/verify-otp`**~~ — shipped via [DEL-14](https://linear.app/oveglobal/issue/DEL-14). See §5e DEL-14 extension + §7 `cross-brand.ts` helpers.
- **Storefront OAuth signup** — gated on [DEL-12](https://linear.app/oveglobal/issue/DEL-12).
- **Multi-tenant E2E test seed** — gated on [DEL-8](https://linear.app/oveglobal/issue/DEL-8).
- **`/welcome` / `/account/setup` flows** — not requested.
- **Magic links** — `auth-spec.md` §7 non-goal.

## 12. Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| BA `acceptInvitation` signature differs from `crud-invites.mjs:222-304` assumption | L | M | Implementation pass re-reads to confirm body shape; hook is one focused file. |
| `redirectTo` change to `/reset-password` invalidates DEL-6 curl smoke recipes | L | L | Commit 5 updates `transactional-emails.md` §9b in same PR. |
| Cross-brand disclosure copy gets long with many siblings | L | L | Acceptable for v1; product polish (e.g., "+ 3 more") later. |
| `?accept=<id>` hook races with auto-sign-in cookie | M | L | BA sets cookie synchronously before redirect; if race appears, wrap accept-call in `setTimeout(..., 0)` or await `useSession`. |
| Invitation URLs without email wiring awkward for testing | confirmed | L | Documented in §5a + §11; curl/SQL until follow-up ships. |
| `acceptInvitation` doesn't actually swallow "already accepted" silently | M | L | §8 explicitly catches + logs + continues; doesn't assume BA behavior. |

## 13. Decisions log

| Date | Decision | Reasoning |
|---|---|---|
| 2026-05-26 | Expanded scope: signup + forgot/reset-password (both apps) | User direction post-DEL-6 ("DEL-7 owns full clickable auth UX"); Linear AC edit post-merge |
| 2026-05-26 | Cross-brand disclosure always-on, not email-lookup-gated | GDPR/trust framing per `auth-spec.md` §10; avoids in-tenant enumeration surface |
| 2026-05-26 | `redirectTo: '/reset-password'` mandatory | `password.mjs:115` throws INVALID_TOKEN without it |
| 2026-05-26 | Two-step invite-accept (signup → verify → autoSignIn → accept hook) | BA `acceptInvitation` requires existing session + emailVerified per `crud-invites.mjs:247` |
| 2026-05-26 | Storefront signup OTP-only (no Google button) | DEL-12 hasn't shipped OAuth account-table tenant scoping |
| 2026-05-26 | Invitation email wiring deferred | Outside DEL-7 expanded scope; follow-up ticket |
| 2026-05-26 | `name` threaded via `?name=` query on storefront signup → verify-otp | BA's `sendVerificationOtp` ignores name; `signIn.emailOtp` uses it on first-create |
| 2026-05-26 | Accept hook is a client component | Next 16 server layouts don't receive `searchParams` |
| 2026-05-26 | "Already accepted" / "already member" treated non-fatally | Don't assume BA behavior unverified at spec time |
