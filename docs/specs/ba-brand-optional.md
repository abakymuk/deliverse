# Brand-optional Better-Auth resolver + adapter (DEL-22) — Spec v1

**Created:** 2026-05-27
**Status:** Draft
**Owner:** Vlad
**Issue:** [DEL-22](https://linear.app/oveglobal/issue/DEL-22)
**ADR:** [0012 — Storefront, Brand, Tenant, and Food Hall Architecture](../decisions/0012-storefront-brand-tenant-food-hall-architecture.md)
**Amendment to:** [ADR-0010 — Storefront tenant scoping](../decisions/0010-tenant-scoping-injection.md)
**Planning doc:** [Issue 5 in food-hall-architecture-linear-plan.md](../planning/food-hall-architecture-linear-plan.md)
**Previous in chain:** [DEL-21 — session.current_brand_id NULL](./session-brand-optional.md)

---

## Problem

ADR-0010 made the storefront BA tenant resolver brand-required: it 400s when no brand resolves, the adapter stamps `current_brand_id` / `brand_id` unconditionally, and `StorefrontTenantContext.brandId` is a required string. This contract is correct for M1 mode-1 / mode-2 (brand-host) but blocks mode-3 (tenant-host food-hall) at HTTP 400 before any business logic runs.

ADR-0012 §"Auth tenant resolution (target)" requires the resolver + adapter to be **tenant-required, brand-optional**: tenant scoping is the security boundary and remains mandatory, but absence of `brandId` is no longer an error. The new contract:

- Resolver returns `{ tenantId, storefrontId, storefrontType, storefrontSlug, brandId?, brandSlug? }`.
- 400 only when the tenant is unresolvable.
- Adapter stamps `current_brand_id` (already DEL-21) and `brand_id` on verification rows only when `brandId` is present.
- Tenant-host OTP / password-reset emails fire with **tenant-default branding** sourced from `storefronts.branding_json` + `tenants.name`/`logo`.

DEL-22 is the highest-risk M1 change — it touches every storefront request and spans three workspace packages. Brand-host behavior must be byte-identical (AC#5 of M1 e2e); the new tenant-host paths are net new.

## Users

- **Tenant-host end users (future)** — food-hall customers signing up / signing in / resetting passwords on `oomi-kitchen.deliverse.app`. The full UX shell ships in DEL-25; DEL-22 enables the auth surface so DEL-25's screens have somewhere to authenticate against.
- **DEL-23 (downstream)** — residual cleanup after DEL-22 pulls the email-branding fallback in. Likely candidates: per-brand from-address, email template visual polish.
- **DEL-25 (downstream)** — food-hall UI shell. Requires working tenant-host auth.

## Acceptance Criteria

Verbatim from [DEL-22](https://linear.app/oveglobal/issue/DEL-22):

1. **AC#1 (spec):** this spec is written, reviewed, and linked from DEL-22.
2. Storefront tenant-context resolver returns `{ tenantId, storefrontId, storefrontType, brandId? }`.
3. Wrapped adapter stamps `current_brand_id` on session writes and `brand_id` on verification writes only when `brandId` is present; tenant scoping (`tenant_id`) unchanged.
4. BA returns HTTP 400 only when tenant is unresolvable. Absence of `brandId` is NOT a 400.
5. ADR-0010 receives an `## Amendment` block citing this issue and ADR-0012.
6. All `docs/auth-spec.md` §6 acceptance criteria pass for both brand-host and tenant-host modes.
7. OAuth signup/login still works in brand-host mode (regression).
8. Tenant-isolation tests still pass: a user at tenant A cannot reach data at tenant B in any mode.

### AC#6 interpretation

`docs/auth-spec.md` §6 ACs are written for brand-host (e.g., §6.4: "End user login at `{brand}.deliverse.app` via email OTP or Google"). "Pass for both modes" means: each AC's analogous behavior holds for tenant-host *for each method actually supported in that mode*. DEL-22 supports tenant-host password signup, password login, OTP, and password-reset. OAuth on tenant-host is **out of scope** (AC#7 explicitly covers brand-host OAuth regression only; tenant-host OAuth callback URL handling is a separate work item, likely DEL-25 or after).

## Non-Goals

- ❌ Food-hall UI shell (DEL-25).
- ❌ Commerce model (DEL-24).
- ❌ Tenant-host OAuth (AC#7 brand-host regression only; tenant-host OAuth is a follow-up).
- ❌ Per-brand or per-tenant from-address — stays env-global `RESEND_FROM_EMAIL`. A follow-up could add `tenants.from_email` / `storefronts.from_email`.
- ❌ Removing the deprecated `extractBrandSlug` export — separate cleanup PR.
- ❌ Schema migration — tenant-mode branding reads existing columns (`storefronts.branding_json`, `tenants.name`, `tenants.logo`).

## Data Model Changes

None. DEL-22 is code-only:
- `storefronts.branding_json` (DEL-19) is the source of truth for tenant-mode email branding (`primary`, `logo`).
- `tenants.name` + `tenants.logo` are fallback for missing storefront branding.
- `tenant_end_user_verifications.brand_id` is already nullable (existing schema). DEL-22 adapter change writes NULL when brand context absent (mirrors DEL-21's session-create pattern).

## API Surface

### `@rp/auth-core`

`StorefrontTenantContext` (post-DEL-22):

```ts
export type StorefrontTenantContext = {
  tenantId: string;
  storefrontId: string;
  storefrontType: 'brand' | 'tenant';
  storefrontSlug: string;   // always present
  brandId?: string;         // present iff storefrontType==='brand'
  brandSlug?: string;       // present iff storefrontType==='brand'; identical to storefrontSlug
};
```

No dual-purpose `brandSlug` — undefined for tenant-host.

`RewriteStorefrontEmailUrlInput.brandSlug` → renamed to `storefrontSlug`. Semantic shift (the slug is "the storefront subdomain the email URL targets"). Single call site; mechanical update.

### `@rp/emails`

New resolver:

```ts
export async function resolveTenantStorefrontEmailContext(
  storefrontId: string,
  tenantId: string,
): Promise<{ storefront: Storefront; tenant: Tenant }>;
```

SQL-side cross-tenant defense (`eq(storefronts.tenantId, tenantId)`) plus post-read symmetry check. Throws `BrandResolutionError` on miss.

Event Zod schemas — backwards-compatible unions. Brand-mode storefront payloads stay mode-less (existing in-flight events still parse); tenant-mode payloads add `mode: 'tenant'`. Handlers branch on `'mode' in data && data.mode === 'tenant'`.

### Tenant-mode email branding fallback chain

- **Display name (`displayName`)**: `storefront.name` → `tenant.name`
- **Primary color**: `storefront.brandingJson.primary` → `DELIVERSE_PRIMARY`
- **Logo**: `storefront.brandingJson.logo` → `tenant.logo` → none
- **Footer attribution**: `Sent by ${storefront.name}` (no parenthetical tenant name — the storefront IS the tenant-facing brand)
- **Subjects**:
  - Password reset: `Reset your password for ${displayName}`
  - OTP login: `Your sign-in code for ${displayName}`
  - OTP email-verify: `Verify your email for ${displayName}`
  - OTP password-reset: `Your password-reset code for ${displayName}`

## UI Sketch

None. No UI in DEL-22.

## Edge Cases

1. **Bare-domain / no subdomain** — resolver 400s with `no resolvable tenant for storefront request — host=… (no storefront subdomain)`. Preserves DEL-3 AC#5 e2e regex `/no resolvable tenant/i`.
2. **Unknown subdomain** — resolver 400s with `(storefront "X" not found or inactive)`. Same regex preserved.
3. **Reserved subdomain** (`admin`, `api`, `www`, `app`) — `extractStorefrontSlug` returns null → 400 (or page-level pass-through in proxy, see DEL-20).
4. **Brand-host request** — `ctx.brandId` / `ctx.brandSlug` populated; adapter behavior verbatim today's code; emails use existing brand-mode path.
5. **Tenant-host request** — `ctx.brandId` / `ctx.brandSlug` undefined; adapter writes NULL for `current_brand_id` + `brand_id`; emails use new tenant-mode path with fallback chain above.
6. **Storefront with empty `branding_json`** — fallback to tenant logo / Deliverse primary color; never breaks template render.
7. **Cross-tenant defense** — `resolveTenantStorefrontEmailContext` adds `eq(storefronts.tenantId, tenantId)` to the SQL where clause AND keeps the post-read mismatch check (belt-and-braces).
8. **Existing in-flight Inngest events without `mode` field** — `z.union` with mode-less brand schemas means they still parse during the deploy window.
9. **OAuth on tenant-host** — out of scope. The BA OAuth callback URL is derived from `baseURL` at init time (frozen to platform host). Brand-host OAuth works via the existing flow; tenant-host OAuth needs a separate per-request callback rewrite mechanism (future work).

## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Brand-host regression | Low | High | M1 e2e suite (DEL-3 / DEL-14 / OTP rate-limit / DEL-20) gates merge. Brand-mode resolver branch returns the same shape (plus inert new fields) |
| `@rp/emails` ripple breaks existing brand-host email flow | Medium | High | Backwards-compatible union schemas preserve mode-less brand payloads; tenant-mode is additive. Handler branches on `'mode' in data && data.mode === 'tenant'`; brand-mode path is verbatim today |
| Tenant-mode email template renders with broken branding | Medium | Medium | Explicit fallback chain documented; unit tests assert each fallback level |
| OAuth brand-host regression (AC#7) | Low | High | DEL-12 unit coverage at `storefront-adapter.test.ts` exercises account-create + lookups; resolver change doesn't touch OAuth handler dispatch |
| In-flight Inngest events without `mode` reject at parse | Low | Medium | `z.union` (not `z.discriminatedUnion`) allows mode-less brand payloads; tested via unit |

## Open Questions

None blocking. Decisions captured below.

## Decisions Log

| Date | Decision | Reasoning |
|---|---|---|
| 2026-05-27 | `StorefrontTenantContext` adds `storefrontSlug` (always present); `brandSlug` stays optional, never dual-purposed | Tenant-mode never reads `ctx.brandSlug`; explicit shape prevents semantic confusion |
| 2026-05-27 | Email branding fallback chain: storefront.brandingJson → tenant.logo / DELIVERSE_PRIMARY; display name: storefront.name → tenant.name | Storefronts already carry `brandingJson` per DEL-19; no schema migration |
| 2026-05-27 | Event Zod schemas use backwards-compatible `z.union` (not `z.discriminatedUnion` on `mode`) | Legacy in-flight brand-mode payloads have no `mode` field; must still parse |
| 2026-05-27 | URL rewriter parameter `brandSlug` → `storefrontSlug` | Semantic shift; single call site; tests updated in same PR |
| 2026-05-27 | Verification adapter `?? null` lands in DEL-22 (not DEL-23) | Linear AC#3 literal reading; removes obsolete `// DEL-23` marker from DEL-21 |
| 2026-05-27 | ADR-0010 amendment appended under existing `## Amendments` heading using DEL-5 / DEL-12 paragraph format | Matches precedent; Linear AC wording "Amendment block" honored by the dated entry |
| 2026-05-27 | OAuth tenant-host out of scope; AC#6 "both modes" interpreted as "supported methods for the mode" | AC#7 brand-host regression coverage only; tenant-host OAuth callback URL handling is separate |
| 2026-05-27 | Per-brand / per-tenant from-address out of scope | `RESEND_FROM_EMAIL` stays env-global; follow-up could add `tenants.from_email` |

---

## Files that will change

**New:**
- `docs/specs/ba-brand-optional.md` — this file.

**Modified:**

`@rp/auth-core`:
- `packages/auth-core/src/storefront-adapter.ts` — widen `StorefrontTenantContext`; verification `?? null`; remove obsolete DEL-23 comment
- `packages/auth-core/src/storefront-adapter.test.ts` — fixture + tenant-mode verification/account regression
- `packages/auth-core/src/storefront.ts` — BA callbacks branch on `storefrontType`
- `packages/auth-core/src/storefront-url.ts` — rename `brandSlug` → `storefrontSlug` in `RewriteStorefrontEmailUrlInput`
- `packages/auth-core/__tests__/storefront-url.test.ts` — rename param + add tenant-host case

`apps/storefront`:
- `apps/storefront/src/lib/storefront-tenant-context.ts` — resolver rewrite using DEL-20 helpers
- `apps/storefront/tests/e2e/storefront-host-resolution.spec.ts` — add 3 tenant-host e2e tests

`@rp/emails`:
- `packages/emails/src/events.ts` — backwards-compatible union schemas
- `packages/emails/src/brand-context.ts` — add `resolveTenantStorefrontEmailContext`
- `packages/emails/src/handlers/password-reset-requested.ts` — branch on `mode`
- `packages/emails/src/handlers/otp-requested.ts` — branch on `mode`
- `packages/emails/src/templates/password-reset.tsx` — discriminated-union props + tenant-mode rendering
- `packages/emails/src/templates/otp.tsx` — same
- `packages/emails/__tests__/brand-context.test.ts` — tenant-mode resolver tests
- `packages/emails/__tests__/otp.test.ts` — tenant-mode handler test
- `packages/emails/__tests__/password-reset.test.ts` — tenant-mode handler test

`docs`:
- `docs/decisions/0010-tenant-scoping-injection.md` — append DEL-22 amendment

**Explicitly NOT modified:**
- `packages/db/src/schema.ts` — no migration
- `apps/storefront/src/lib/cross-brand.ts` — NULL-safe by SQL semantics
- `packages/auth-core/src/storefront-host.ts:extractBrandSlug` — stays `@deprecated`
