# DEL-15 — Storefront BA email URLs (multi-tenant baseURL fix) — Spec v1

**Created:** 2026-05-26
**Status:** In Progress
**Owner:** Vlad
**Linear:** [DEL-15](https://linear.app/oveglobal/issue/DEL-15/storefront-ba-email-urls-point-at-platform-host-multi-tenant-baseurl)

---

## Problem

Storefront-instance Better-Auth emits password-reset emails whose links point at the **platform** host (`admin.deliverse.app/reset-password/...`) instead of the brand subdomain the user is on (`pizza-express.deliverse.app/reset-password/...`). The link lands the user on the wrong app, wrong cookie domain, wrong session — the reset flow is broken in prd. Surfaced during DEL-7 prd smoke; documented as known limitation in PR #26.

`packages/auth-core/src/storefront.ts` does not set `baseURL` on its `betterAuth(...)` call. BA reads `process.env.BETTER_AUTH_URL` once at init and freezes it on `ctx.context.baseURL`. Doppler sets that env to the platform's URL because platform is the canonical authority. The storefront BA is multi-tenant (one instance for every brand subdomain) so a fixed `baseURL` is structurally wrong — every request from a different brand needs a different URL host.

> **Evolution note.** This spec covers the brand-host baseURL rewriter from M1 (DEL-15). Tenant-host food-hall storefronts now also derive baseURL from the resolved storefront — DEL-22 generalized the helper input from `brandSlug` to `storefrontSlug` (same logic, broader semantics), so the rewriter works for both brand-host (`brand-slug.deliverse.app`) and tenant-host (`tenant-slug.deliverse.app`) modes per [ADR-0012](../decisions/0012-storefront-brand-tenant-food-hall-architecture.md). The brand-host path described below is unchanged; tenant-host parity is captured in [`docs/specs/ba-brand-optional.md`](./ba-brand-optional.md).

Confirmed from installed `better-auth@1.6.11` (`dist/api/routes/password.mjs:72`):

```js
const url = `${ctx.context.baseURL}/reset-password/${verificationToken}?callbackURL=${callbackURL}`;
```

The dynamic-baseURL infrastructure in BA 1.6.11 (`DynamicBaseURLConfig` allowedHosts + protocol strategy) is **not** used by `password.mjs` — only the static `ctx.context.baseURL` is. So a function-shape `baseURL` callback is not viable in this BA version.

## Users

- **Restaurant guests (end users)** of any storefront brand who hit "Forgot password" on their brand's subdomain. Today their reset email is broken.
- **Tenants** with multiple brands: every brand's reset flow is broken until this lands.

## Acceptance Criteria

1. Storefront-instance BA password-reset emails construct URLs whose origin is the brand subdomain the user came from, not the platform host.
2. Curl smoke: `POST http://pizza-express.localhost:3001/api/auth/request-password-reset` → Inngest event `email.password_reset.requested` `data.url` starts with `http://pizza-express.localhost:3001/reset-password/...`.
3. Multi-tenant: same request against `burger-heaven.localhost:3001` → `data.url` uses the `burger-heaven` subdomain.
4. Unit tests cover both brands and all three envs (dev/stg/prd) plus path+query preservation.
5. `docs/specs/transactional-emails.md` and `docs/specs/auth-ui.md` no longer carry the "storefront forgot-password broken" limitation note.

## Non-Goals

- ❌ Platform URLs — already correct (platform's `BETTER_AUTH_URL` IS its URL).
- ❌ Per-request BA factory (fix path A) — bigger surface, not needed for a one-callback problem. File a follow-up if a second URL-bearing storefront BA callback ever lands.
- ❌ DynamicBaseURLConfig refactor (fix path B) — BA 1.6.11's password route bypasses it.
- ❌ OTP / OAuth / verification-email flows — OTP carries a code not a URL; OAuth uses Google's own redirect; `sendVerificationEmail` is unset on storefront (no `requireEmailVerification`).
- ❌ Vercel `*.deliverse.app` wildcard fix (pre-existing prd infra gap from DEL-7 smoke; tracked separately).

## Data Model Changes

None. `StorefrontTenantContext` stays at `{tenantId, brandId, brandSlug}`; `passwordResetRequestedEvent` Zod schema (`packages/emails/src/events.ts`) already accepts the rewritten URL value (`z.string().url()`).

## API Surface

No new events, actions, or endpoints. The existing `email.password_reset.requested` event payload's `url` field now carries the correctly-hosted URL.

New internal helper (package-private, not exported from the package barrel):

```
packages/auth-core/src/storefront-url.ts
  └── rewriteStorefrontEmailUrl({ originalUrl, brandSlug, baseDomain, proto }) → string
```

Pure function. Replaces the origin of a BA-constructed URL with `${proto}://${brandSlug}.${normalizedBaseDomain}`. Preserves path + query.

## Approach

**Fix path: C — URL post-processor in the storefront `sendResetPassword` callback.**

1. `packages/auth-core/src/storefront-url.ts` — new pure helper.
2. `packages/auth-core/src/storefront.ts` — in the `sendResetPassword` callback ([storefront.ts:132-145](../../packages/auth-core/src/storefront.ts:132)) after resolving tenant context: rewrite the BA-provided `url` via the helper, then dispatch the Inngest event with the rewritten value.

The brand subdomain is reconstructed from `ctx.brandSlug` (already in `StorefrontTenantContext` since DEL-5) + `process.env.NEXT_PUBLIC_STOREFRONT_BASE_DOMAIN` (already used by `trustedOrigins` in the same file). This keeps `packages/auth-core` framework-free (no `next/headers` import) — per ADR-0009 dep-direction.

Protocol derivation matches the existing `trustedOrigins` pattern in `storefront.ts:179`: `process.env.NODE_ENV === 'production' ? 'https' : 'http'`. Both staging and prd run with `NODE_ENV=production`, so both get `https`.

## Edge Cases

1. **Missing `NEXT_PUBLIC_STOREFRONT_BASE_DOMAIN`** — throw a clear `Error` from the callback. The env is already required elsewhere in the same file (trustedOrigins + extractBrandSlug) so missing it is a deploy-config bug, not a runtime case. BA's reset endpoint still 200s to the user (enumeration protection), but no email goes out and the misconfiguration is loud in logs.
2. **Doppler dev historical scheme prefix** — `NEXT_PUBLIC_STOREFRONT_BASE_DOMAIN` was sometimes set as `http://localhost:3001`. The helper strips an optional `<scheme>://` prefix (mirrors the tolerant parsing in `storefront-host.ts:normalizeDomain`). Port is kept.
3. **BA URL with `?callbackURL=...`** — the callbackURL query value is already URI-encoded by BA. `new URL(...).toString()` round-trips it; the helper does not touch the query.
4. **Reserved-subdomain hosts (`admin`, `www`, `api`, `app`)** — these can never reach storefront BA because `extractBrandSlug` returns null for them and `resolveStorefrontTenantContext` throws `BAD_REQUEST` before the BA callback runs. No special handling needed.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Wrong env value (Doppler) silently produces wrong URL | L | M | helper does not validate the env content; trust the deploy-config check that already exists for `extractBrandSlug` |
| Future BA upgrade changes URL construction path | L | M | unit tests assert the output shape; if BA changes the input format, tests fail loudly |
| Adding `vitest` to `packages/auth-core` perturbs the dep tree | L | L | `vitest` is already a devDep in `packages/emails` (same workspace) — no new global lockfile entry |

## Open Questions

None remaining (decided during plan review).

## Decisions Log

| Date | Decision | Reasoning |
|---|---|---|
| 2026-05-26 | Path C over Path A | Surface is one callback today; Path A is a refactor that doesn't pay off until a second URL-bearing flow exists. |
| 2026-05-26 | Path B not viable | BA 1.6.11's `password.mjs:72` uses static `ctx.context.baseURL`, ignores the `DynamicBaseURLConfig` resolver. Confirmed by reading installed source. |
| 2026-05-26 | Reconstruct host from `brandSlug + baseDomain` | Avoids extending `StorefrontTenantContext` to carry a raw host; keeps `packages/auth-core` framework-free (no `next/headers`). |
| 2026-05-26 | Tests live in `packages/auth-core/__tests__/` | Mirrors `packages/emails` convention. |
| 2026-05-26 | No ADR | Contained bug fix on top of ADR-0010's tenant-scoping pattern. |

---

## Files that will change

**New:**
- `packages/auth-core/src/storefront-url.ts` — pure helper
- `packages/auth-core/__tests__/storefront-url.test.ts` — unit tests
- `docs/specs/del-15-storefront-baseurl.md` — this spec

**Modified:**
- `packages/auth-core/src/storefront.ts` — invoke the helper in `sendResetPassword`
- `packages/auth-core/package.json` — add `vitest` devDep + `test` script
- `packages/auth-core/tsconfig.json` — include `__tests__/**/*.ts`
- `docs/specs/transactional-emails.md` — remove limitation note
- `docs/specs/auth-ui.md` — remove limitation note
