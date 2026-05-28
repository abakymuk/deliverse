# Food-hall test matrix (DEL-26) — Spec v1

**Created:** 2026-05-28
**Status:** Draft
**Owner:** Vlad
**Issue:** [DEL-26](https://linear.app/oveglobal/issue/DEL-26)
**ADR:** [0012 — Storefront, Brand, Tenant, and Food Hall Architecture](../decisions/0012-storefront-brand-tenant-food-hall-architecture.md)
**Planning doc:** [`docs/planning/food-hall-architecture-linear-plan.md`](../planning/food-hall-architecture-linear-plan.md) Issue 9
**Prior art:** [`docs/specs/food-hall-storefront.md`](./food-hall-storefront.md) (DEL-25 — food-hall shell), [`docs/specs/commerce-schema-v1.md`](./commerce-schema-v1.md) (DEL-24 — commerce schema), [`docs/specs/storefront-host-resolution.md`](./storefront-host-resolution.md) (DEL-20), [`docs/specs/ba-brand-optional.md`](./ba-brand-optional.md) (DEL-22), [`docs/specs/verification-brand-optional.md`](./verification-brand-optional.md) (DEL-23), [`docs/specs/storefront-tenant-scoping.md`](./storefront-tenant-scoping.md) (DEL-3)

---

## Problem

[ADR-0012](../decisions/0012-storefront-brand-tenant-food-hall-architecture.md) §"Supported modes" defines three storefront modes that must all pass simultaneously:

| Mode | Description | Canonical fixture |
|---|---|---|
| 1 — Single-brand tenant | One restaurant, one brand, one storefront. | (missing — added by DEL-26 under `SEED_TEST_FIXTURES`) |
| 2 — Multi-brand separate brand storefronts | Hospitality Group runs Pizza Express + Burger Heaven on their own subdomains. | `hospitality-group` (canonical) |
| 3 — Food hall | OOMI Kitchen hosts OOMI Burger + OOMI Pizza in one storefront with a unified cart. | `oomi-kitchen-test` (canonical) |

Phase 2 shipped the implementation across DEL-19 → DEL-25, with each PR adding its own e2e coverage. What's left is the consolidation pass: prove that **all three modes pass concurrently**, and that the tenant-isolation + cookie-leak invariants survive across the architectural pivot. DEL-26 is that consolidation.

The test surface is already large (six storefront e2e specs + one platform spec). Without an inventory, regressions in one mode caused by work on another can hide — there's no canonical map of which spec covers which AC. This spec is that map.

## Users

- **Future contributors** — read this matrix to know "if I touch X, which spec proves I didn't break it" without grepping the entire e2e tree.
- **The Phase 2 wrap-up review** — proves DEL-26's seven ACs are met by linking each AC to a spec + test ID.
- **Phase 3 reviewers** — when commerce features evolve (KDS, payments, multi-location food halls), this matrix shows what coverage already exists.

## Acceptance Criteria

Verbatim from [DEL-26](https://linear.app/oveglobal/issue/DEL-26):

1. **AC#1 (spec):** this spec is written, reviewed, and linked from DEL-26.
2. e2e: Mode 1 (single-brand tenant) flow passes on a single-brand seeded tenant.
3. e2e: Mode 2 (separate brand storefronts) flow passes — cross-brand recognition disclosure renders; same email logs in across two brands of one tenant with one account.
4. e2e: Mode 3 (food hall) flow passes — multi-brand cart, single checkout, single order with brand-tagged line items.
5. Tenant-isolation tests still pass — same email at tenant A and tenant B are independent in all modes.
6. Brand cookie-leak tests still pass — cookies scoped to exact storefront slug.
7. Test matrix documented: which spec covers which mode × which auth method × which seeded tenant.

## Non-Goals

- ❌ Load testing.
- ❌ Visual regression testing.
- ❌ Test infrastructure refactor — fixture-lifecycle library, shared `beforeAll` consolidation, helper extraction beyond what already exists in `tests/e2e/helpers/`.
- ❌ Replacing existing per-feature e2e specs (DEL-3/20/22/23/24/25) with consolidated ones. Each existing spec stays; this PR adds two new specs (mode-1, cookie-isolation) and a single fixture.
- ❌ Adding mode-1 coverage to canonical stg/prd seed. Mode-1 fixture lives behind `SEED_TEST_FIXTURES=1`.
- ❌ Re-deriving the AC#3 / AC#4 / AC#5 / AC#6 coverage from scratch — existing specs cover these; the matrix below documents them.

## Data Model Changes

**None.** DEL-26 is test-coverage-only. The `solo-cafe-test` seed fixture added by this PR uses the existing schema unchanged.

The fixture lives in `packages/db/src/seed.ts` under `SEED_TEST_FIXTURES=1` alongside `other-co-test`:

```
new tenant: solo-cafe-test (status='active')
new brand:  solo-cafe-test (under solo-cafe-test, isActive=true, brandingJson={})
new location: Solo Cafe Kitchen (under solo-cafe-test)
new location_brand: Solo Cafe Kitchen ↔ solo-cafe-test brand
new storefront: solo-cafe-test (type='brand', primaryBrandId=brand.id)
new menu: Solo Cafe Menu (under brand)
new menu_item: House Espresso ($4.50, deterministic UUID)
```

All inserts are idempotent — partial-unique constraints on `tenants.slug` / `brands.slug` / `storefronts.slug` plus deterministic UUIDs on `locations.id` / `menus.id` / `menu_items.id` (matches `other-co-test` + DEL-24 patterns).

## API Surface

**None.** DEL-26 is test-only.

## Test Matrix

The canonical inventory: every e2e spec × the mode(s) it covers × the auth methods exercised × the seed fixture(s) it depends on × the DEL-26 AC it satisfies.

| Spec | Mode 1 | Mode 2 | Mode 3 | Auth methods | Seed fixtures | DEL-26 AC satisfied | Source issue |
|---|---|---|---|---|---|---|---|
| [auth.spec.ts](../../apps/storefront/tests/e2e/auth.spec.ts) | — | ✅ disclosure + cross-brand login + welcome-back + tenant-iso | — | OTP, password (HTTP) | hospitality-group + `SEED_TEST_FIXTURES` (other-co-test) | AC#3, AC#5 (brand-host pair) | DEL-7, DEL-8, DEL-14 |
| [commerce-schema.spec.ts](../../apps/storefront/tests/e2e/commerce-schema.spec.ts) | — | ✅ DB-layer cart with mixed brand_id + FK cascade | ✅ DB-layer mixed-brand line items | DB-only (no HTTP) | hospitality-group (canonical) | AC#4 (data layer) | DEL-24 |
| [food-hall.spec.ts](../../apps/storefront/tests/e2e/food-hall.spec.ts) | — | — | ✅ full UI flow: directory → brand → cart → checkout → mixed-brand order | password (HTTP fast-path) | oomi-kitchen-test (canonical) | AC#4 (UI + DB) | DEL-25 |
| [otp-rate-limit.spec.ts](../../apps/storefront/tests/e2e/otp-rate-limit.spec.ts) | — | ⚠️ brand-host OTP guards (mode-2 by venue) | — | OTP | hospitality-group | — (regression gate) | DEL-9 |
| [storefront-host-resolution.spec.ts](../../apps/storefront/tests/e2e/storefront-host-resolution.spec.ts) | — | ✅ brand-host routing | ✅ tenant-host routing + tenant-host password signup + tenant-host OTP + tenant-host password reset | OTP, password (HTTP) | hospitality-group + oomi-kitchen-test (canonical) | AC#3 (routing), AC#4 (routing) | DEL-20, DEL-22, DEL-23 |
| [storefront-tenant-scoping.spec.ts](../../apps/storefront/tests/e2e/storefront-tenant-scoping.spec.ts) | — | ✅ positive + sibling-brand + cross-tenant + negative | — | password (HTTP) | hospitality-group + ephemeral `other-co-del3-test` (test-owned) | AC#5 (cross-tenant) | DEL-3, DEL-12 |
| **mode-1-single-brand.spec.ts** (new — DEL-26) | ✅ single-brand routing + signup + disclosure absent + cart + order | — | — | password (HTTP) | `SEED_TEST_FIXTURES` (solo-cafe-test) | AC#2 | DEL-26 |
| **cookie-isolation.spec.ts** (DEL-26) | ⚠️ Domain config (storefront-agnostic) | ⚠️ Domain config (storefront-agnostic) | ⚠️ Domain config (storefront-agnostic) | password (HTTP) | hospitality-group (canonical) | AC#6 | DEL-26 |

Legend:
- ✅ = canonically covered (at least one test asserts the invariant).
- ⚠️ = tangentially covered (the spec asserts something else but exercises the path).
- — = not applicable / not covered by this spec.

## Existing Coverage Mapping (DEL-26 AC → existing test IDs)

### AC#3 — Mode 2 cross-brand disclosure + cross-brand login

Source spec: [`docs/specs/auth-ui.md`](./auth-ui.md) (DEL-7 disclosure copy + DEL-14 welcome-back copy).

- Disclosure renders on `/signup` when tenant has siblings: [auth.spec.ts:51](../../apps/storefront/tests/e2e/auth.spec.ts:51) — *"signup page shows sibling-brand disclosure"*.
- Cross-brand welcome-back on `/verify-otp`: [auth.spec.ts:62](../../apps/storefront/tests/e2e/auth.spec.ts:62) — *"verify-otp shows welcome-back when crossing brands (DEL-14)"*.
- Same-brand path does NOT show welcome-back: [auth.spec.ts:91](../../apps/storefront/tests/e2e/auth.spec.ts:91) — *"verify-otp shows default copy when same brand as signup"*.
- Same email → same `tenant_end_users` row across sibling brands: [storefront-tenant-scoping.spec.ts:148](../../apps/storefront/tests/e2e/storefront-tenant-scoping.spec.ts:148) — *"AC #4 sibling-brand — same email at burger-heaven … does not duplicate the user row"*.

### AC#4 — Mode 3 food-hall flow

Source spec: [`docs/specs/food-hall-storefront.md`](./food-hall-storefront.md) (DEL-25).

- Full UI flow (directory → brand subsection → cart → checkout → mixed-brand order with DB assertions): [food-hall.spec.ts:114](../../apps/storefront/tests/e2e/food-hall.spec.ts:114) — *"full flow: signup → add from 2 brands → cart → checkout → order detail"*.
- DB-layer multi-brand cart + mixed-brand order: [commerce-schema.spec.ts:142](../../apps/storefront/tests/e2e/commerce-schema.spec.ts:142) — *"AC#8 — cart with line items from 2 brands → order with 2 mixed-brand line items"*.
- Tenant-host directory rendering (DEL-25 stub→directory swap): [storefront-host-resolution.spec.ts:115](../../apps/storefront/tests/e2e/storefront-host-resolution.spec.ts:115) — *"tenant host renders food-hall directory with brand cards"*.
- Tenant-host signup/OTP/reset all write `currentBrandId=NULL`: [storefront-host-resolution.spec.ts:192](../../apps/storefront/tests/e2e/storefront-host-resolution.spec.ts:192) tests 7–10.

### AC#5 — Tenant isolation across modes

Source spec: [`docs/specs/storefront-tenant-scoping.md`](./storefront-tenant-scoping.md) (DEL-3) + [`docs/specs/del-12-account-tenant-scoping.md`](./del-12-account-tenant-scoping.md) (DEL-12).

- Cross-tenant brand signup creates two distinct user rows: [storefront-tenant-scoping.spec.ts:177](../../apps/storefront/tests/e2e/storefront-tenant-scoping.spec.ts:177) — *"AC #4 cross-tenant — same email at a second tenant succeeds"*.
- Same invariant via the canonical `SEED_TEST_FIXTURES` slug: [auth.spec.ts:119](../../apps/storefront/tests/e2e/auth.spec.ts:119) — *"same email at different tenants are different accounts"*.
- Negative case (no resolvable tenant → 400, no row written): [storefront-tenant-scoping.spec.ts:217](../../apps/storefront/tests/e2e/storefront-tenant-scoping.spec.ts:217) — *"AC #5 negative — request with no resolvable brand returns 400 and writes no row"*.
- Tenant-host (mode-3) signup is also tenant-scoped (writes `tenantId=oomi-kitchen-test`): [storefront-host-resolution.spec.ts:192](../../apps/storefront/tests/e2e/storefront-host-resolution.spec.ts:192) test 7.

The matrix above shows mode-2 ↔ mode-2 cross-tenant is covered. Mode-3 ↔ mode-2 cross-tenant (food-hall tenant vs brand-host tenant, same email) is NOT explicitly tested today. See § "Open Questions §1".

### AC#6 — Brand cookie-leak

Source: this spec. No existing spec asserts cookie isolation. DEL-26's [`cookie-isolation.spec.ts`](../../apps/storefront/tests/e2e/cookie-isolation.spec.ts) is the canonical test.

AC#6 wording is "cookies scoped to exact storefront slug." That refers to the cookie's `Domain` attribute — the **browser-side** scoping that keeps a browser from sending a storefront-A cookie on a request to storefront B. The BA cookie config in [`packages/auth-core/src/storefront.ts`](../../packages/auth-core/src/storefront.ts) sets `advanced.crossSubDomainCookies.enabled = false` plus `cookiePrefix = 'rp_store'`; with `Domain` defaulted to the exact origin, a browser will never auto-send the cookie cross-storefront.

The spec exercises this by:

- Signing up at `pizza-express.localhost:3001` via password.
- Collecting every `Set-Cookie` header on the response (BA emits several — session token + session data).
- For each, asserting: no wildcard `Domain` (no leading `.`); any explicit `Domain` equals the exact storefront subdomain; an absent `Domain` is accepted (defaults to exact origin per RFC 6265).

One brand-host signup proves the invariant for all storefronts — the BA cookie config is shared across every storefront, so per-storefront re-testing would re-test the same config.

## New Specs Added by DEL-26

### `apps/storefront/tests/e2e/mode-1-single-brand.spec.ts`

Tests Mode 1 (single-brand tenant) on the new `solo-cafe-test` fixture. HTTP-driven (matches `storefront-tenant-scoping.spec.ts` pattern — no browser, all assertions via Playwright `request` fixture + `@rp/db`).

Cases:

1. **Home rendering** — GET `solo-cafe-test.localhost:3001/` returns 200 and body contains the brand name. Routing layer treats it as `type='brand'` (no food-hall directory).
2. **Signup stamps tenant + brand correctly** — `POST /api/auth/sign-up/email` → 200; `tenant_end_users.tenantId` = solo-cafe tenant; `tenant_end_user_sessions.currentBrandId` = solo-cafe brand UUID (NOT null — single-brand storefront is `type='brand'`).
3. **Sibling-brand disclosure absent** — GET `solo-cafe-test.localhost:3001/signup` returns 200 and body does NOT contain "is part of" (the DEL-7 disclosure pattern). Single-brand tenant has nothing to disclose.
4. **Cart with one brand → order with one brand on line items** — DB-driven (matches commerce-schema.spec.ts AC#8 pattern). Insert cart + cart_item + order + order_line_item; assert `brand_id` on the line item matches the single brand UUID.

Setup: `beforeAll` resolves the canonical `solo-cafe-test` fixture (errors loudly if `SEED_TEST_FIXTURES=1` wasn't run). `afterAll` cleans up the ephemeral test user + order. Uses `describe.serial` so afterAll fixtures don't race parallel workers.

### `apps/storefront/tests/e2e/cookie-isolation.spec.ts`

Tests AC#6 — cookie `Domain` attribute scopes BA session cookies to the exact storefront subdomain (browser-side leak guard).

Single case:

- **Domain config check** — Sign up at `pizza-express.localhost:3001` via password. Collect every `Set-Cookie` header. For each, assert the `Domain` attribute is either absent (defaults to exact origin) or exactly `pizza-express.localhost`. No wildcard `Domain` (no leading `.` — would leak across subdomains per AGENTS.md §Gotchas).

The ephemeral test user is cleaned up in `afterAll`.

The cross-tenant server-side replay tests (which would assert BA rejects a cookie minted at tenant A when replayed at tenant B) stay dropped — session-model-scoped narrowed the gap at the write layer but cookieCache short-circuits the read path. See § Open Questions §2.

### Note on cookie-isolation test history

An earlier draft for DEL-26 included the brand-host → tenant-host and tenant-host → brand-host cookie-replay tests. Running them in `dev` exposed a real defense-in-depth gap rather than a regression — the wrapped adapter at the time excluded `session` from `SCOPED_MODELS` per the original DEL-3 contract. DEL-26 shipped with only the Domain-attribute check (AC#6 wording covered); the gap was tracked in § Open Questions §2.

**Partial closure 2026-05-28 by session-model-scoped** + **full closure 2026-05-27 by [`cookie-cache-tenant-version.md`](./cookie-cache-tenant-version.md)** (Phase 3 M1). Migration `0008_slimy_wrecking_crew.sql` (session-model-scoped) added `tenant_id` to `tenant_end_user_sessions` and `SCOPED_MODELS` extended to include `session`. The remaining cookieCache short-circuit was closed by the BA `session.cookieCache.version` callback in cookie-cache-tenant-version — the callback runs `resolveTenantContext()` at both write and read time, so a cross-tenant cached payload's `version` field mismatches the read-tenant's expected version → BA expires the cookie → falls through to the wrapped adapter → tenant predicate rejects → null user. The cross-tenant cookie-replay tests are now restored in [`cookie-isolation.spec.ts`](../../apps/storefront/tests/e2e/cookie-isolation.spec.ts) as tests 2 + 3 (pizza-express → oomi-kitchen-test and reverse). The Domain-attribute check (test 1) is unchanged from DEL-26.

## Edge Cases

1. **`SEED_TEST_FIXTURES=1` not set when running mode-1 spec** — `beforeAll` throws with a clear error message ("solo-cafe-test fixture not seeded — run `SEED_TEST_FIXTURES=1 pnpm db:seed`"). CI sets the flag in the deploy step; local dev needs it explicitly for the storefront e2e suite.
2. **CI worker race on shared fixtures** — Mode-1 and cookie-isolation specs use `describe.serial` for tests that share fixture lifecycle. Tests across different spec files run in parallel workers, but each spec owns its own ephemeral users (timestamp + random nonce in email), so cross-spec collision is impossible.
3. **Cookie format varies by BA version** — BA 1.6.x uses `rp_store.session_token` (storefront BA cookie prefix per DEL-17). The cookie-isolation spec doesn't parse the cookie; it replays the raw `set-cookie` header value. Format changes don't break the test.
4. **`solo-cafe-test.localhost` not in `/etc/hosts`** — Chrome auto-resolves `*.localhost` to 127.0.0.1 (established by Pizza Express + OOMI Kitchen specs). Playwright honors the same.
5. **Mode-1 user already exists from a prior local run** — emails are timestamp + nonce, so re-runs don't collide. `afterAll` deletes the test user; if the test fails mid-flow, the orphan user has a `del26-mode1-*@solo.test` shape that's grep-cleanable.
6. **Cookie-isolation test fails because storefront B accepts the cookie** — this is the failure mode we're guarding against. It would indicate a regression in BA cookie scoping (possibly a `Domain=.deliverse.app` slip — AGENTS.md §Gotchas calls this out). Fail-loud with a clear assertion message.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Mode-1 spec races OOMI canonical seed UUIDs | Low | Low | UUID range for `solo-cafe-test` is 80–93 (range 0–73 reserved per DEL-24/25 seed). |
| Cookie-isolation spec fragile to BA cookie format changes | Low | Low | Spec replays raw `set-cookie` header byte-for-byte; doesn't parse cookie name/value. Future BA upgrades that change cookie format will not break the test as long as the server-side rejection behavior holds. |
| Mode-1 fixture in `SEED_TEST_FIXTURES` block doesn't run in CI | Negligible | High | CI explicitly sets `SEED_TEST_FIXTURES=1` (see [packages/db/AGENTS.md](../../packages/db/AGENTS.md) + GitHub Actions config). Verified by the existing `auth.spec.ts:119` test which depends on `other-co-test`. |
| New solo-cafe-test fixture lacks an `/etc/hosts` entry in dev | Low | Low | Chrome auto-resolves `*.localhost`. If a non-Chrome dev environment ever runs the suite, document the `127.0.0.1 solo-cafe-test.localhost` entry alongside the existing brand subdomains. |
| Tests pass locally but fail in CI due to `SEED_TEST_FIXTURES` ordering | Low | Medium | CI runs `pnpm db:migrate && pnpm db:seed` (with the flag set) before `pnpm test:e2e`. Confirmed by recent PR #64 — `fix(ci): run db:seed after migrate on stg + prd deploys`. Spec's `beforeAll` reads the fixture from DB, doesn't insert it. |
| `apps/platform/next-env.d.ts` auto-modified during local e2e run | High | Negligible | Pre-flight `git restore apps/platform/next-env.d.ts` before staging files (AGENTS.md §Gotchas). |

## Open Questions

1. **Mode-3 ↔ Mode-2 cross-tenant explicit test.** AC#5 says "same email at tenant A and tenant B are independent in all modes." The matrix covers brand-host pairs (mode-2 ↔ mode-2). A `oomi-kitchen-test` ↔ `hospitality-group` cross-tenant pair (same email, food-hall tenant + brand-host tenant) is not explicitly tested. The same DEL-3 wrapped-adapter code path runs in both modes, so the invariant holds by construction — but an explicit test would prove it. Deferred to a follow-up if it ever becomes meaningful; the brand-host pair test already proves the adapter does the right thing per tenant.
2. **Closed 2026-05-27 — server-side cross-tenant session-cookie replay gap.** Initial closure attempt 2026-05-28 ([`session-model-scoped.md`](./session-model-scoped.md)) added `tenant_id` to `tenant_end_user_sessions`, extended `SCOPED_MODELS` to include `session`, and stamped `tenantId` on `session.create` — closed every adapter-routed session path. The cookieCache short-circuit was closed 2026-05-27 by [`cookie-cache-tenant-version.md`](./cookie-cache-tenant-version.md) (Phase 3 M1) via the BA `session.cookieCache.version` callback: cross-tenant replay during the cache window now forces a version mismatch → BA expires the `session_data` cookie → falls through to the wrapped adapter → tenant predicate rejects → BA returns null user. The cross-tenant replay tests are restored as tests 2 + 3 in [`apps/storefront/tests/e2e/cookie-isolation.spec.ts`](../../apps/storefront/tests/e2e/cookie-isolation.spec.ts) — both directions (pizza-express → oomi-kitchen-test and reverse) assert the server-side replay returns null. The Next.js 16 post-server-action-redirect bare-host quirk that previously blocked cookieCache disable is now handled by a Referer/Origin fallback in the resolver + matching `x-storefront-id` injection in the proxy (no upstream Next.js fix required).
3. **Mode-1 OTP flow.** The new mode-1 spec uses password-only signup. OTP signup on a single-brand tenant uses the same DEL-22 brand-host code path that `auth.spec.ts:33` already exercises on Pizza Express. Adding a mode-1 OTP test would be redundant; skipped.
4. **Mode-1 canonical (visible in stg/prd) vs. test-only.** v1 picks test-only (`SEED_TEST_FIXTURES=1`) per the decision logged below. A future demo PR could promote `solo-cafe-test` to canonical if a stg/prd showcase becomes valuable.
5. **Helper consolidation across e2e specs.** Several specs duplicate `resolveTenantId` / `resolveBrandId` / `nonce` helpers. Refactoring to a shared `tests/e2e/helpers/db.ts` is tracked as a separate concern (DEL-26 Non-goal § 3). Not blocking.

## Decisions Log

| Date | Decision | Reasoning |
|---|---|---|
| 2026-05-28 | Single PR (not split) | Two new spec files + one seed addition + one doc. ~600 lines projected. Smaller than DEL-25's PRs; no architectural surface; single review unit makes sense. |
| 2026-05-28 | `solo-cafe-test` lives under `SEED_TEST_FIXTURES`, not canonical | M3 Definition of Done doesn't require mode-1 prd visibility (only mode-3 does, per DEL-25 § "Canonical seed"). Matches `other-co-test` precedent. Reduces stg/prd seed noise. Future demo promotion is a one-line move. |
| 2026-05-28 | Mode-1 spec is HTTP-driven, not browser-driven | Matches `storefront-tenant-scoping.spec.ts` precedent for AC-coverage e2es. Browser-driven food-hall spec (mode-3) exists already; mode-1's invariants are routing + adapter + disclosure absence, all assertable via HTTP + DB. |
| 2026-05-28 | Cookie-isolation spec replays raw `set-cookie` header, doesn't parse | Survives BA cookie format changes. Asserts the server-side guard, not the cookie name/value. |
| 2026-05-28 | No explicit mode-3 ↔ mode-2 cross-tenant test in this PR | The DEL-3 wrapped-adapter code path is shared across modes; the brand-host pair test already proves the invariant. Adding the cross-mode pair would be duplication for negligible coverage gain. Tracked as Open Question §1. |
| 2026-05-28 | Test matrix lives in this spec, not in `AGENTS.md` or `apps/storefront/AGENTS.md` | One canonical location for the AC-coverage map. AGENTS.md links here when a contributor needs to know "where is X tested". |
| 2026-05-28 | `solo-cafe-test` deterministic UUID range is 80–93 | Range 0–73 already used by hospitality-group + OOMI commerce + DEL-24 cart fixture. 80+ leaves a 6-UUID gap for future fixtures. |
| 2026-05-28 | `solo-cafe-test` storefront slug == brand slug == tenant slug | Mode 1's degenerate case per ADR-0012 §"Supported modes". The three concepts coincide for single-brand tenants by definition. Matches `oomi-burger-test` brand-storefront pattern (same slug for brand row + brand-storefront row). |
| 2026-05-28 | Cookie-isolation spec narrowed to single Domain-attribute test | Initial draft included server-side cross-tenant replay tests that exposed a defense-in-depth gap (Open Question §2) rather than a regression. AC#6 wording ("cookies scoped to exact storefront slug") is satisfied by the Domain-attribute check alone; server-side cross-tenant rejection is a separate invariant that doesn't hold today by design. Cross-tenant tests deferred to the follow-up that closes the gap, to avoid shipping `.fixme()` tests in DEL-26. |

---

## Files that will change

- `docs/specs/food-hall-test-matrix.md` (new — this spec)
- `packages/db/src/seed.ts` (modify — add `solo-cafe-test` fixture block under `SEED_TEST_FIXTURES=1`)
- `apps/storefront/tests/e2e/mode-1-single-brand.spec.ts` (new — AC#2)
- `apps/storefront/tests/e2e/cookie-isolation.spec.ts` (new — AC#6)

**Explicitly NOT modified:**

- `packages/db/src/schema.ts` — no schema changes.
- `packages/db/migrations/*` — no migrations.
- `apps/storefront/src/**` — no application code.
- `packages/auth-core/src/**` — no adapter or resolver changes.
- Existing e2e specs (`auth.spec.ts`, `commerce-schema.spec.ts`, `food-hall.spec.ts`, `otp-rate-limit.spec.ts`, `storefront-host-resolution.spec.ts`, `storefront-tenant-scoping.spec.ts`) — coverage stands as-is.
