# BA cookieCache cross-tenant version callback + proxy bare-host fallback — Spec v1

**Created:** 2026-05-27
**Status:** Draft
**Owner:** Vlad
**Linear:** (Phase 3 M1 — `BA cookieCache cross-tenant version callback + proxy bare-host fallback`)
**ADR:** [`0010-tenant-scoping-injection.md`](../decisions/0010-tenant-scoping-injection.md) (this spec adds a dated Amendment)
**Closes:** [`session-model-scoped.md`](./session-model-scoped.md) § Open Questions §1; [`food-hall-test-matrix.md`](./food-hall-test-matrix.md) § Open Questions §2
**Builds on:** [PR #76](https://github.com/abakymuk/deliverse/pull/76) (session-model-scoped: schema + write-layer + DB-direct read-path closure)

---

## Problem

[PR #76](https://github.com/abakymuk/deliverse/pull/76) (session-model-scoped) added `tenant_id` to `tenant_end_user_sessions`, extended `SCOPED_MODELS` to include `session`, and stamped `tenantId` on `session.create`. That closed the cross-tenant cookie-replay gap for every **adapter-routed** session call — `findOne`/`findMany`/`delete-session-by-token`/etc. all gained the tenant predicate.

**What it did not close:** BA's `dist/api/routes/session.mjs` short-circuits `get-session` when `cookieCache.enabled: true` — it decrypts the cached session payload directly from the signed `session_data` cookie (5-min TTL) **without calling the adapter**. So cross-tenant cookie replay during the cache window still returns the source-tenant payload, even after PR #76.

```
attacker copies pizza-express cookie → replays at oomi-kitchen-test/api/auth/get-session
  → BA sees session_data cookie, cookieCache.enabled, version check
  → today: version field defaults to "1" → matches → returns cached pizza-express user+session
  → desired: version callback returns oomi-kitchen-test's tenantId → mismatch → expire →
    fall through to adapter → wrapped adapter predicate excludes cross-tenant session →
    BA returns null user
```

PR #76 documented two viable closure paths. This spec implements the first: hook BA's `session.cookieCache.version` callback (an explicit BA hook, present in 1.6.11 — see [§ "BA mechanism"](#ba-mechanism) below) into the same `resolveTenantContext` closure that the wrapped adapter already uses. At cache-write time the callback runs in the writer-tenant's request context → the cached payload's `version` field becomes the writer-tenant's `tenantId`. At cache-read time it runs in the reader-tenant's request context → cross-tenant replay forces a version mismatch → BA expires the cookie → falls through to the wrapped adapter → the PR #76 tenant predicate rejects → BA returns `null` user.

Closing the cookieCache path forces every cookieCache-disable workaround off the table — which surfaces a second problem PR #76 also called out: Next.js 16's post-server-action-redirect page render drops the storefront subdomain from `Host` (the [orders/[orderId]/page.tsx](../../apps/storefront/src/app/(shop)/orders/[orderId]/page.tsx) header comment documents the quirk). When the cookieCache hit no longer short-circuits the adapter for the page render's in-process `auth.api.getSession()`, the wrapped adapter's `resolveStorefrontTenantContext` runs and throws on the bare `Host`. The order-detail page errors.

The spec therefore closes both gaps in one PR: BA `cookieCache.version` callback + a Referer/Origin fallback in `resolveStorefrontTenantContext` and a matching `x-storefront-id` injection in the proxy. The closure is co-designed — without the fallback, the version callback would break the order-detail page; without the version callback, the fallback alone wouldn't close the security gap.

## Users

- **Restaurant guests (end users)** — close the defense-in-depth gap against cross-tenant info disclosure for the full 5-minute cookieCache window, not just on cache misses.
- **Future auditors / security reviews** — every storefront BA `get-session` path now applies tenant scoping. The "cookieCache hits skip the predicate" caveat in [`storefront-tenant-scoping.md` § 5.2](./storefront-tenant-scoping.md) is removed.
- **Future contributors** — the bare-host page-render path (post-server-action-redirect) is documented as a known Next.js 16 quirk with a self-healing fallback, so future framework upgrades don't silently regress the order-detail flow.

## BA mechanism

Source-verified at [`node_modules/better-auth/dist/api/routes/session.mjs`](file:node_modules/better-auth/dist/api/routes/session.mjs) lines 93-104 (read) + [`node_modules/better-auth/dist/cookies/index.mjs`](file:node_modules/better-auth/dist/cookies/index.mjs) lines 69-86 (write) at BA 1.6.11:

```js
// dist/cookies/index.mjs:69-86 — setCookieCache (called at write time)
const versionConfig = ctx.context.options.session?.cookieCache?.version;
let version = "1";
if (versionConfig) {
  if (typeof versionConfig === "string") version = versionConfig;
  else if (typeof versionConfig === "function") {
    const result = versionConfig(session.session, session.user);
    version = isPromise(result) ? await result : result;
  }
}
// ... payload { session, user, updatedAt, version } stored in signed cookie

// dist/api/routes/session.mjs:93-104 — get-session (called at read time)
if (sessionDataPayload?.session && ctx.context.options.session?.cookieCache?.enabled && !ctx.query?.disableCookieCache) {
  const session = sessionDataPayload.session;
  const versionConfig = ctx.context.options.session?.cookieCache?.version;
  let expectedVersion = "1";
  if (versionConfig) {
    if (typeof versionConfig === "string") expectedVersion = versionConfig;
    else if (typeof versionConfig === "function") {
      const result = versionConfig(session.session, session.user);
      expectedVersion = result instanceof Promise ? await result : result;
    }
  }
  if ((session.version || "1") !== expectedVersion) expireCookie(ctx, ctx.context.authCookies.sessionData);
  else { /* return cached session */ }
}
// fall-through after expireCookie: ctx.context.internalAdapter.findSession(token)
// → hits the wrapped adapter → PR #76 tenant predicate → cross-tenant rejected
```

`version` callback signature: `(session, user) => string | Promise<string>`. Cached payload's `version` field is what the callback returned at **write** time. At **read** time the callback re-runs in the read request's context and BA compares. Mismatch → `expireCookie` deletes the `session_data` cookie → falls through to `internalAdapter.findSession(token)` (the wrapped adapter) → PR #76 predicate. No try/catch around the callback — a throw propagates as the route's response (APIError → 400, other → 500).

## Acceptance Criteria

1. **Spec written.** This document, linked from the Linear issue + ADR-0010 § Amendments. Spec covers the resolver-source precedence chain explicitly so reviewers can sanity-check the security property.
2. **BA config (package-boundary clean).** [`packages/auth-core/src/storefront.ts`](../../packages/auth-core/src/storefront.ts) registers `session.cookieCache.version` as an async callback that calls the closure-captured `resolveTenantContext()` and returns `ctx.tenantId`. **`packages/auth-core` does not import app code.** The callback runs in BA's request context at both write time (`setCookieCache` post-signin/signup) and read time (`get-session` cookie-cache path); both invocations re-enter the same closure the wrapped adapter uses.
3. **Resolver precedence chain.** [`apps/storefront/src/lib/storefront-tenant-context.ts`](../../apps/storefront/src/lib/storefront-tenant-context.ts) reads the storefront identity from this ordered chain:
   1. **`x-storefront-id` header (proxy-injected).** **Trusted only because the proxy strips any client-supplied `x-storefront-id` from `request.headers` before its own injection — current [`proxy.ts`](../../apps/storefront/src/proxy.ts) lines 48-49 already strip `PROXY_OWNED_HEADERS` as the first non-trivial step.** Value is a UUID (the storefront row id). Resolver looks it up via a new `resolveStorefrontById` query against `storefronts` + `tenants` (same active+non-deleted predicates as `resolveStorefrontBySlug`).
   2. **`Host` header + `extractStorefrontSlug`.** Canonical source for `/api/*` requests (see [AC#4](#proxy-fallback--api-short-circuit-interaction-explicit-spec-point) for why these don't get proxy injection) and any direct adapter call that bypasses the proxy. Falls through to source #3 only when `Host` doesn't yield a known active storefront.
   3. **`Referer` header + `extractStorefrontSlug`.** Fallback for the post-server-action-redirect render path where Next.js 16 drops the storefront subdomain from `Host`. The browser sets `Referer` to the originating page (which is on the storefront subdomain); `extractStorefrontSlug` then recovers the slug from the URL.
   4. **`Origin` header + `extractStorefrontSlug`.** Last-resort backup for cases where some hop strips `Referer` (privacy headers, CORS preflights). Same `extractStorefrontSlug` extractor as sources #2 and #3.

   The resolver throws `APIError('BAD_REQUEST', { code: 'TENANT_CONTEXT_REQUIRED' })` only when **all four** sources fail — preserves the DEL-3 AC#5 negative behavior on truly anonymous requests.

   **Security property (must be preserved by future edits):** the proxy strips client-supplied `x-storefront-id` BEFORE re-injecting. If a future contributor reverses the order, a malicious client could spoof their `x-storefront-id` and the resolver would trust it. The strip-before-inject ordering is the entire reason source #1 is trusted. Tests for this property live in `apps/storefront/tests/proxy-header-strip.test.ts` (existing) — review them whenever this resolver changes.

4. **Proxy fallback + `/api` short-circuit interaction (explicit spec point).** [`proxy.ts`](../../apps/storefront/src/proxy.ts) currently strips `PROXY_OWNED_HEADERS` (line 48-49), then short-circuits `/api/*` requests (line 51-53) **before** resolving + injecting storefront headers. This spec preserves the ordering:

   - **For `/api/*` routes** (BA endpoints like `/api/auth/get-session`, `/api/auth/sign-in/email`, etc.): proxy strips client-supplied `x-storefront-id` but does NOT inject its own. The resolver falls through to **`Host`** (precedence chain source #2), which is the correct source for direct API requests from a browser or programmatic client at a real subdomain. The `cookieCache.version` callback during a `get-session` request follows this path. **Cross-tenant replay test (curl `Host: oomi-kitchen-test.localhost:3001 ... /api/auth/get-session` with a pizza-express cookie) hits this path** — the resolver returns OOMI context, the version callback returns OOMI's `tenantId`, the cached payload's `version` is pizza-express's `tenantId`, BA expires the cookie, falls through to the adapter, the predicate excludes the cross-tenant session, BA returns `null`.

   - **For page routes** (RSC renders like `/orders/<id>`): proxy strips client-supplied `x-storefront-id` and (with this PR) **injects** its own via the same Referer/Origin fallback as the resolver. The post-redirect page render's `await headers()` reflects the proxy-injected value; the in-process `auth.api.getSession({headers})` propagates it to the `cookieCache.version` callback. The bare-host order-detail page now resolves correctly.

   **Do NOT move the proxy injection before the `/api` short-circuit.** It would force every BA call to do an extra DB lookup (slug → storefront row) it doesn't need — every `get-session` call would carry a 5-15ms penalty for no security gain (the resolver already does the same lookup downstream). The split-path behavior (`/api`: rely on `Host`; pages: rely on injected `x-storefront-id`) is the design.

5. **Resolver memoization (implementation goal, not test gate).** Wrap `resolveStorefrontTenantContext` in React's `cache()` (`import { cache } from 'react';`) so per-render duplicate invocations (e.g., page → layout → component all calling `getStorefrontContext`) dedupe automatically. This is a **new behavior added by this PR** — the resolver is **not** currently `cache()`-wrapped (only the `tenant-resolution.ts` consumer wrappers are).

   **Do not enforce via unit-test DB-call-count assertion.** React `cache()` is request/render scoped and requires a Next.js request context (`AsyncLocalStorage`-based) to exercise; a Vitest unit test doesn't trivially provide that. The hard acceptance signal is **end-to-end behavior**: existing e2e tests (food-hall, auth, storefront-host-resolution, storefront-tenant-scoping, cookie-isolation) must still complete within current time budgets after the change. Treat memoization as an implementation goal; verify via code review + e2e wall-clock as a soft check.

6. **Restored e2e (the eviction proof).** The two cross-tenant cookie-replay tests deferred during DEL-26 are written and added to [`apps/storefront/tests/e2e/cookie-isolation.spec.ts`](../../apps/storefront/tests/e2e/cookie-isolation.spec.ts):

   - **Test 2:** sign up at `pizza-express.localhost:3001` via password (HTTP fast-path). Capture every `Set-Cookie` from the signup response. Compose those cookies into a `Cookie:` header and replay at `http://oomi-kitchen-test.localhost:3001/api/auth/get-session`. Assert response is HTTP 200 with body `{ "user": null, ... }` or just `null` (BA's get-session-with-no-session shape — confirmed at runtime against `node_modules/better-auth/dist/api/routes/session.mjs:204` `return ctx.json(null)`).
   - **Test 3:** reverse direction — sign up at `oomi-kitchen-test.localhost:3001` via password, replay at `pizza-express.localhost:3001/api/auth/get-session`, assert `null` user.

   These two tests **ARE the cookie-cache-eviction validation.** The eviction happens inside BA's route code (`session.mjs:104` `expireCookie`) on the read-path version mismatch, then falls through to the wrapped adapter's `findSession`. Unit tests at the adapter layer can't observe the cookie-cache hit + eviction sequence — it's an HTTP-route-level behavior. The e2e tests are the only mechanism that exercises the full chain.

7. **No regression on food-hall mode-3 + order-detail render.** [`apps/storefront/tests/e2e/food-hall.spec.ts`](../../apps/storefront/tests/e2e/food-hall.spec.ts) end-to-end (mode-3 OOMI flow with post-server-action-redirect order-detail page render) still passes. The resolver Referer/Origin fallback covers the bare-host case that previously required `cookieCache: true` to mask. If Next.js 16 strips BOTH `Referer` AND `Host` on post-redirect renders (see [§ Risks](#risks) for the worst-case mitigation), the test would fail — and the failure would be a real signal, not a flake, so we'd surface and fix it.

8. **ADR + spec amendments.**
   - [`docs/decisions/0010-tenant-scoping-injection.md`](../decisions/0010-tenant-scoping-injection.md) gains a dated **Amendment** entry (matching the DEL-5 / DEL-12 / DEL-22 / session-model-scoped precedent).
   - [`session-model-scoped.md`](./session-model-scoped.md) § Open Questions §1 moves to a Decisions Log entry (closed).
   - [`food-hall-test-matrix.md`](./food-hall-test-matrix.md) § Open Questions §2 is marked **closed**.
   - [`storefront-tenant-scoping.md`](./storefront-tenant-scoping.md) § 5.2 session-row caveat ("cookieCache hit skips the predicate") is removed; the §5.2 row is updated to reflect that the predicate now applies on every `get-session` path (cookieCache hit triggers version-callback eviction → DB lookup → predicate; cookieCache miss → DB lookup directly).

## Non-Goals

- ❌ **Postgres RLS.** [auth-spec §12](./auth-spec.md) deferral stands; we close the gap at the application layer.
- ❌ **A short-lived signed cookie carrying the storefront id as a last-resort fallback.** Documented in [§ Risks](#risks) as the contingency if Next.js 16 strips both `Referer` AND `Host`. Not implemented in v1 — the Referer/Origin chain is sufficient against today's known behavior; the signed-cookie fallback is a documented escape hatch.
- ❌ **Memoization correctness asserted in unit tests.** React `cache()` is request-scoped; verifying it requires a Next.js request context. Code review + e2e wall-clock is the acceptance signal — see [AC#5](#acceptance-criteria).
- ❌ **Refactor of `tenant-resolution.ts`** consumer wrappers (`getStorefrontContext`, `getBrandContext`). They keep their existing React `cache()` wrapping; the underlying `resolveStorefrontTenantContext` adding its own `cache()` is additive (idempotent — `cache()`-of-`cache()` is fine, the outer just dedupes earlier).
- ❌ **New error codes.** The bad-host failure path still throws `APIError('BAD_REQUEST', { code: 'TENANT_CONTEXT_REQUIRED' })` — same as today, fires only when all four sources fail.
- ❌ **Changing BA's `cookieCache.maxAge`** (currently 5 min) or `cookieCache.enabled` flag. Both stay as-is; this PR adds the version callback alongside.

## Data Model Changes

**None.** The `tenant_end_user_sessions.tenant_id` column added by [PR #76](https://github.com/abakymuk/deliverse/pull/76) provides the column the wrapped adapter's session predicate uses. No new tables, no new columns, no new indexes.

## API Surface

No new actions or endpoints. Existing surfaces gain the following behaviors:

- **`/api/auth/get-session` (and any in-process `auth.api.getSession({headers})` from RSC):** the cookieCache hit path now runs the version callback; cross-tenant cached payloads expire and fall through to the wrapped adapter.
- **`packages/auth-core/src/storefront-resolver.ts`:** new exported function `resolveStorefrontById(id: string): Promise<(StorefrontContext & { slug: string }) | null>`. Same active+non-deleted predicates as `resolveStorefrontBySlug`; returns the storefront row's `slug` alongside the standard context so callers don't need a second lookup to reconstruct the resolver context.
- **`apps/storefront/src/lib/storefront-tenant-context.ts`:** the exported `resolveStorefrontTenantContext()` is now wrapped in React `cache()`. Same return type, same throw behavior — call sites need no change.
- **`apps/storefront/src/proxy.ts`:** on bare-host page renders, the proxy injects `x-storefront-id` (resolved via Referer/Origin fallback). The `/api/*` short-circuit ordering is unchanged.

## Edge Cases

1. **Cache write at signup, read at the same tenant.** Writer-tenant `tenantId` is stamped in cache `version`. Read-tenant request at the same storefront resolves to the same `tenantId`. Match → cached session returned. No regression on the normal flow.

2. **Cache write at signup at pizza-express, attacker replays at oomi-kitchen-test via curl `/api/auth/get-session`.** Proxy strips `x-storefront-id`, short-circuits `/api/*`. BA's version callback calls `resolveTenantContext()` → `Host` source → OOMI's `tenantId`. Cached `version` = pizza-express's `tenantId`. Mismatch → `expireCookie` → falls through to `internalAdapter.findSession(token)` → wrapped adapter applies tenant predicate `tenant_id = OOMI` → session row has `tenant_id = pizza-express` → no match → returns null → BA emits `deleteSessionCookie` + `ctx.json(null)`. Attacker gets `null` user. **Gap closed.**

3. **Post-server-action-redirect page render at OOMI (food-hall flow).** User submits checkout server action at `oomi-kitchen-test.deliverse.app/checkout`; server action returns `redirect('/orders/<id>')`. Next.js renders the orders page in a new render pass; the new pass has a bare `Host`. Browser-bound: `Referer` = the originating `/checkout` page on `oomi-kitchen-test.deliverse.app`. Proxy: `Host` bare → Referer fallback → slug `oomi-kitchen-test` → resolves to storefront row → injects `x-storefront-id`. Page render: `auth.api.getSession({headers: await headers()})` → BA's get-session → cookieCache hit → version callback → `resolveTenantContext()` → x-storefront-id source #1 → OOMI's `tenantId`. Cached `version` = OOMI's `tenantId` (writer same tenant). Match → cached session returned. Page renders.

4. **Browser-side `/api/auth/get-session` poll at OOMI.** Browser fetches `/api/auth/get-session` from `oomi-kitchen-test.deliverse.app`. `Host` = `oomi-kitchen-test.deliverse.app` (the storefront subdomain). Proxy: strips `x-storefront-id`, short-circuits `/api/*`. BA: cookieCache hit → version callback → `resolveTenantContext()` → `Host` source #2 → OOMI's `tenantId`. Match → cached session returned. No regression.

5. **Programmatic worker constructing storefront BA with a different `resolveTenantContext`.** If a future Inngest worker constructs `createStorefrontAuth(someFixedTenantResolver)`, the version callback runs with that worker's resolver — fine, the design is symmetric (writer + reader use the same closure).

6. **`Referer` is `null` and `Host` is bare (rare).** Worst case: privacy headers strip `Referer` AND Next.js 16 drops `Host`. Origin fallback (source #4) covers most cases — `Origin` is sent on CORS-relevant requests and on same-origin POST/PUT/DELETE in modern browsers. If all four sources fail, the resolver throws `APIError('BAD_REQUEST', ...)`. Page render fails (500-ish; or the page's try/catch downgrades to 404). Documented contingency: [§ Risks](#risks) row 1 — last-resort signed cookie from the redirecting server action.

7. **UUID format guard on `x-storefront-id`.** The resolver does a defensive regex check on `x-storefront-id` before hitting the DB (`/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i`). Garbage input doesn't poison the DB connection pool with malformed-UUID errors. If the format is OK but the row doesn't exist (deleted/inactive storefront), the resolver falls through to source #2 instead of throwing.

8. **Cookie-cache refresh path interaction.** BA's session route refreshes the cached cookie when `timeUntilExpiry < cookieRefreshCache.updateAge` (lines 132-178 in `session.mjs`). The refresh calls `setCookieCache` again, which re-invokes the version callback. Since the refresh runs in the same request context as the read, it returns the same tenant id — the new cached payload's `version` field matches the request tenant. No drift.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Next.js 16 strips BOTH `Referer` AND `Host` on the post-server-action-redirect render. | Low-Med | High | Origin fallback covers most cases. If even Origin is stripped, the contingency is a short-lived signed cookie set by the redirecting server action: encode the storefront id in a signed cookie with `maxAge: 10s, Path: /, SameSite: Strict`; the resolver adds source #5 reading from it. **Not implemented in v1** — only kicks in if e2e surfaces this as the failure mode. Documented here so a future contributor finds the contingency rather than rediscovering the problem. |
| BA 1.6.x → 1.7.x changes the `cookieCache.version` callback signature or removes it. | Low | High | Pinned at `better-auth@1.6.11`. BA major versions historically retain hook surfaces with deprecation cycles (DEL-22 `socialProviders` hook change was deprecated-then-removed across two minors). Upgrade reviewer is on the hook for re-reading `dist/api/routes/session.mjs` + `dist/cookies/index.mjs`. |
| The version callback throws when `resolveTenantContext` can't resolve (true bad request reaching `/api/auth/get-session`). | Low | Low | The throw is `APIError('BAD_REQUEST', ...)` which BA serializes as HTTP 400 — same behavior as the wrapped adapter today on bare-host adapter calls. Browser-side `auth.api.getSession` callers see `null` (BA converts 4xx to null at the client). RSC `auth.api.getSession({headers})` callers see an error; food-hall.spec.ts is the regression gate. |
| React `cache()` doesn't dedupe outside an RSC render context (the version callback runs in a route handler). | Med | Low | Memoization is an implementation goal, not a correctness gate (AC#5). Worst case: every version callback invocation does a fresh DB hit (~5-15ms Neon pooled). Acceptable. The dedupe still applies on RSC pages where multiple components call `getStorefrontContext` in the same render. |
| Proxy regex matcher misses some `/api/*` shape and runs full injection on it. | Low | Med | The matcher is `'/((?!_next/static|_next/image|favicon.ico|.*\\.).*)'`. All `/api/auth/*` paths match. The proxy's path-based `if (pathname.startsWith('/api'))` short-circuit is the gate; reviewed in [`storefront-host-resolution.spec.ts`](../../apps/storefront/tests/e2e/storefront-host-resolution.spec.ts). |
| Cross-tenant test fails because cookieCache is somehow disabled in CI (env override). | Low | Low | The test asserts the **null user** outcome, not the eviction path. Whether the null came from version-callback eviction or from cookieCache being off entirely, the security property holds. Both directions of the test are independent assertions. |
| `extractStorefrontSlug` from a `Referer` URL pointing at a 3rd-party origin (`https://google.com/foo`) returns null. | Expected | None | `extractStorefrontSlug` only matches hosts ending in `.${baseDomain}`. Foreign origins return null, the resolver falls through to source #4 (Origin) or throws. Correct behavior — we shouldn't trust a Referer pointing somewhere else. |

## Open Questions

1. **Confirm React `cache()` works inside BA's route handler context.** AC#5 acknowledges this isn't a hard gate; the implementation adds the wrap regardless. If profiling shows the version callback is a bottleneck in prd, the next step is to switch to a request-scoped `AsyncLocalStorage`-based memoizer that's framework-agnostic. Tracked as a follow-up Linear issue only if surfaced — not pre-emptively.

## Decisions Log

| Date | Decision | Reasoning |
|---|---|---|
| 2026-05-27 | BA `cookieCache.version` callback (option 1 from session-model-scoped § OQ§1), not the Next.js Host-drop fix (option 2). | Option 2 requires an upstream Next.js fix or a config change we don't control. Option 1 is in-tree, surgical, and BA 1.6.11 already exposes the hook. Trading "wait for upstream" for "ship the closure now" is the right call given the security gap is open today. |
| 2026-05-27 | Closure-captured `resolveTenantContext` reused in the version callback, no separate resolver instance. | Single source of truth for the request → tenant context mapping. If the resolver ever changes (e.g., new precedence sources), the callback gets the change for free. Keeps `packages/auth-core` Next-free — the closure body lives in the app. |
| 2026-05-27 | Resolver precedence chain ordered `x-storefront-id → Host → Referer → Origin`. | `x-storefront-id` is the cheapest (no slug extraction) and most authoritative (proxy-resolved). `Host` is the canonical source for direct API requests. `Referer` covers the documented Next.js 16 post-redirect quirk. `Origin` is the privacy-headers-respecting fallback. All four use the same `extractStorefrontSlug` extractor (#2-#4) or `resolveStorefrontById` (#1) for consistency. |
| 2026-05-27 | Proxy does NOT inject `x-storefront-id` on `/api/*` paths. | Performance: every BA call would carry a slug-resolution penalty for no security benefit (the resolver does the lookup downstream anyway). The split-path design (`/api`: rely on `Host`; pages: rely on injected `x-storefront-id`) keeps the hot `get-session` path cheap. |
| 2026-05-27 | Proxy strips client-supplied `PROXY_OWNED_HEADERS` BEFORE the `/api` short-circuit (preserved from existing code). | Defense-in-depth on every path. A future contributor moving the strip below the short-circuit would let `/api/*` callers spoof their `x-storefront-id` (low impact today since `/api/*` doesn't use that header — but the spec calls it out as a known landmine). |
| 2026-05-27 | React `cache()` on `resolveStorefrontTenantContext` is an implementation goal, not a test gate. | React `cache()` is request-scoped and requires a Next.js render context; a Vitest unit test can't trivially provide it. Net cost is one DB hit per request without memoization (~5-15ms Neon pooled) — acceptable until profiling says otherwise. |
| 2026-05-27 | Cross-tenant cookie-replay tests are HTTP-driven (Playwright `request`), not browser-driven. | The threat model is explicit header injection / programmatic clients; a browser refuses to send a cookie cross-storefront due to the `Domain` attribute (already covered by test 1). HTTP-driven replay is the right tool for the right test. |
| 2026-05-27 | `resolveStorefrontById` lives in `@rp/auth-core/storefront-resolver` (not in the app). | Same dep direction as `resolveStorefrontBySlug` — packages stay Next-free, query lives where it's reused. The resolver in `storefront-tenant-context.ts` (app) calls into the package. |
| 2026-05-27 | Last-resort signed cookie carrying the storefront id is documented but NOT implemented in v1. | YAGNI until the failure mode surfaces in e2e. The resolver chain has four sources; the signed cookie is source #5 if needed. Documenting the path means a future contributor doesn't have to re-derive it from scratch under fire. |

---

## Files that will change

**New:**
- `docs/specs/cookie-cache-tenant-version.md` (this spec — AC#1).

**Modified:**
- `packages/auth-core/src/storefront.ts` — add `session.cookieCache.version` async callback in `createStorefrontAuth` (AC#2). Update the inline NOTE block to reflect the new mechanism.
- `packages/auth-core/src/storefront-resolver.ts` — add `resolveStorefrontById(id)` exporting `(StorefrontContext & { slug: string }) | null`.
- `packages/auth-core/src/storefront-host.ts` — add `extractHostFromUrl(value)` helper (pure, no env dep) so the resolver + proxy both consume the same parser.
- `packages/auth-core/package.json` — no new exports (existing barrel files re-export).
- `apps/storefront/src/lib/storefront-tenant-context.ts` — add the four-source precedence chain (AC#3) + wrap the export in React `cache()` (AC#5).
- `apps/storefront/src/proxy.ts` — add the bare-host Referer/Origin fallback for page routes only (AC#4); `/api` short-circuit ordering preserved.
- `apps/storefront/tests/e2e/cookie-isolation.spec.ts` — add the 2 cross-tenant cookie-replay tests (AC#6). Update the header doc comment to reflect "cross-tenant guard now in place."
- `docs/decisions/0010-tenant-scoping-injection.md` — dated Amendment entry (AC#8).
- `docs/specs/session-model-scoped.md` — move § Open Questions §1 to a Decisions Log entry (AC#8).
- `docs/specs/food-hall-test-matrix.md` — mark § Open Questions §2 as closed (AC#8).
- `docs/specs/storefront-tenant-scoping.md` — remove § 5.2 session-row cookieCache caveat; update § 11 Amendments (AC#8).

**Explicitly NOT modified:**

- `packages/auth-core/src/storefront-adapter.ts` — the adapter wrapper's `session.findOne` predicate is what catches the post-eviction DB lookup. No change needed; PR #76 already added the predicate.
- `packages/auth-core/src/storefront-adapter.test.ts` — adapter unit tests can't observe the cookieCache eviction (eviction is in BA's route code, before the adapter is reached). The cookie-isolation e2e tests are the eviction proof.
- `packages/db/src/schema.ts` + `packages/db/migrations/*` — no schema changes; the `tenant_id` column from PR #76 (migration `0008_slimy_wrecking_crew.sql`) is what the predicate uses.
