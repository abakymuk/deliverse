# DEL-8 — E2E in CI: seeded test DB + `*.localhost` Playwright wiring — Spec v1

**Created:** 2026-05-27
**Status:** Shipped
**Owner:** Vlad
**Linear:** [DEL-8](https://linear.app/oveglobal/issue/DEL-8)
**Builds on:** [DEL-1](https://linear.app/oveglobal/issue/DEL-1) (seed), [DEL-3](https://linear.app/oveglobal/issue/DEL-3) (tenant-scoping), [DEL-7](https://linear.app/oveglobal/issue/DEL-7) (signup), [DEL-12](https://linear.app/oveglobal/issue/DEL-12) (account tenant scoping), [DEL-16](https://linear.app/oveglobal/issue/DEL-16) (seed onConflictDoUpdate + admin pw env)
**Unblocks:** `test.skip` placeholders in `apps/storefront/tests/e2e/auth.spec.ts:52` (tenant isolation); future cross-tenant OAuth E2E test gated on a separate Google OAuth test-double slice ([DEL-12 follow-up](https://linear.app/oveglobal/issue/DEL-12)).

---

## Problem

`.github/workflows/ci.yml` only runs lint + typecheck + unit tests (all mocked) + build. The `e2e` job was dropped during M0 because "seed data + tenant subdomain test setup are not ready." Every M1 ship since DEL-3 has been verified solely by staging/prd smokes — high friction, easy to skip, slow feedback.

Existing E2E specs cover real flows but only run locally if you remember to invoke `pnpm exec playwright test` against a dev stack. They've also got a pre-existing bug: platform `auth.spec.ts` hardcodes a password that doesn't match any actual seeded value post-DEL-16.

Intended outcome: every PR gets a green/red signal on the real auth flows via the new `e2e` CI job.

## Users

- **Future feature developers** — get fast (~5min) feedback that their change didn't break auth before they hit stg smoke.
- **Future agents picking up tickets** — won't waste time guessing seeded test passwords or fighting CI infra they don't have context on.

## Acceptance Criteria (mirrors Linear)

1. ✅ This spec written.
2. ✅ CI workflow restores `e2e` job with chosen seed strategy.
3. ✅ Playwright `webServer` config in both apps boots on hostnames Playwright can hit. (Already correct pre-DEL-8; storefront uses `pizza-express.localhost:3001`. No config change needed.)
4. ✅ `apps/platform/tests/e2e/auth.spec.ts` — un-skipped, covers AC#3 (login) + AC#5 (404 leakage; existing redirects-to-login test satisfies).
5. ✅ `apps/storefront/tests/e2e/auth.spec.ts` — un-skipped tenant-isolation test now implemented; AC#1/#2/#4/#10 covered (tenant isolation new; cross-brand disclosure already active per DEL-7; OTP request already active; password toggle already active).
6. ⏳ Green on PR to staging + PR to main — verified by the CI run on this PR.

## Non-Goals

- ❌ Full OTP code-entry roundtrip — needs OTP readback design (env-gated `storeOTP: 'plain'` or Inngest event interception). File follow-up if needed.
- ❌ Google OAuth E2E — needs Google OAuth test-double. DEL-12's `test.skip` in storefront-tenant-scoping.spec.ts stays.
- ❌ OTP rate-limit E2E (DEL-9 brings its own).
- ❌ Visual regression / screenshot tests.
- ❌ Inngest/Resend integration E2E (covered by stg/prd smokes per [`docs/smoke-credentials.md`](smoke-credentials.md)).

## Decisions Log

### DB strategy (AC #1)

**Picked: option (i) — Postgres service container per CI run.**

The three options + reasoning:

| Option | Description | Pro | Con | Verdict |
|---|---|---|---|---|
| **(i) Postgres service container** | GitHub Actions `services:` block runs postgres:16-alpine fresh per CI run | Fast (~5s startup), zero external deps, no API tokens, fully reproducible, ephemeral | Doesn't catch Neon-specific behavior | **Chosen.** Drizzle uses stock pg; Neon-specific quirks unlikely in basic auth flows. Add option (ii) as a nightly job later if needed. |
| (ii) Neon preview branch per run | Neon API creates a branch, destroys after | Parity with prod | Needs Neon API token in CI secrets, slower, branch cleanup risk | Rejected for now |
| (iii) Shared CI Neon branch + TRUNCATE fixture | Single always-on branch, fixture resets per run | Cheapest Neon resources | Concurrent-run collision risk, fragile state mgmt | Rejected |

### Inngest scope

**`pnpm dlx inngest-cli@latest dev --no-discovery` as a background sink.** Pre-flight on 2026-05-27 confirmed it accepts POSTed events (HTTP 200, `{ids, status: 200}` response) without rejecting "unknown" event names. With `INNGEST_DEV=1` the Inngest SDK posts to localhost:8288 and the CLI accepts as sink → BA route handlers complete cleanly.

**We do NOT claim handler/function coverage in CI:**
- `--no-discovery` disables auto-fetch of registered functions
- Playwright `webServer` only boots the app being tested, so platform's `/api/inngest` registry isn't always alive during storefront tests
- If we ever want real handler execution in CI: separate slice — start platform standalone + `curl -X PUT http://localhost:3000/api/inngest` to register, then trigger storefront events. Out of DEL-8 scope.

### Test password wiring (pre-existing bug)

Platform `auth.spec.ts` hardcoded `SuperSecretPassword123!` matched no actual seeded password. Fix: env-driven via `E2E_ADMIN_PASSWORD`, sane local default (`Admin-Dev-Pass-1` = seed `DEFAULT_ADMIN_PASSWORD`).

CI workflow couples `SEED_ADMIN_PASSWORD` and `E2E_ADMIN_PASSWORD` to the same value so the seeded hash matches the test's expected plaintext.

### `*.localhost` resolution

`/etc/hosts` entry added in CI via `sudo tee -a`. Modern Chromium auto-resolves `.localhost` per RFC 6761 (so the hosts entry is belt-and-suspenders, but free). All 5 subdomains used by tests are covered (pizza-express, burger-heaven, other-brand-test, other-brand-del3-test, admin).

### Multi-tenant seed

`packages/db/src/seed.ts` extended with an `SEED_TEST_FIXTURES=1` env-flagged block adding a second tenant (`other-co-test`) + brand (`other-brand-test`). Idempotent (same `onConflictDoNothing` pattern as canonical seed). Canonical seed stays minimal for staging/prd; test fixture only provisioned in CI.

The existing `storefront-tenant-scoping.spec.ts` `beforeAll` creates `other-co-del3-test` (different slug, kept for backcompat). Slugs could converge in a follow-up cleanup; out of DEL-8 scope.

## Edge Cases

1. **Inngest CLI rejects POSTs in some future version** — pre-flight pinning recommendation in `.github/workflows/ci.yml` comment. If CLI changes break the sink behavior, fall back to dropping Inngest CLI from CI entirely (let `inngest.send` fail silently; BA's `runInBackgroundOrAwait` shouldn't surface as 500).
2. **GitHub Actions runner without sudo** — none today, but if Actions ever locks down `sudo tee` on hosts, switch to a wildcard DNS service (nip.io: `pizza-express.127.0.0.1.nip.io:3001`).
3. **Storefront test runs require platform to be alive for Inngest send** — false. The storefront BA fires `inngest.send` directly; Inngest CLI handles the receive. Platform's `/api/inngest` registry is only needed for handler invocation (which we explicitly don't cover).
4. **Concurrent CI runs collide on shared admin@test.local** — postgres service container is per-job-instance (not shared across runs). No collision.

## Files that changed

**New:**
- `docs/specs/del-8-e2e-ci-setup.md` (this file)

**Modified:**
- `.github/workflows/ci.yml` — new `e2e` job (replaces the commented-out placeholder)
- `packages/db/src/seed.ts` — append `SEED_TEST_FIXTURES=1` test-fixture block
- `apps/platform/tests/e2e/auth.spec.ts` — env-driven `ADMIN_PW` (fixes pre-existing hardcoded-password bug)
- `apps/storefront/tests/e2e/auth.spec.ts` — implement the tenant-isolation test that was previously `test.skip()`; add `db` import for the DB assertion

**Not modified (intentional):**
- `apps/{platform,storefront}/playwright.config.ts` — current shapes work; cross-brand tests use explicit URLs not baseURL
- `apps/storefront/tests/e2e/storefront-tenant-scoping.spec.ts` — DEL-12's `test.skip` stays (Google OAuth test-double out of scope); the active tests just need CI infra which this PR provides

## Verification

### Local

```bash
# 1. SEED_TEST_FIXTURES works
SEED_TEST_FIXTURES=1 doppler run --config dev -- pnpm db:seed
doppler run --config dev -- bash -c 'psql "$DATABASE_URL" -c "SELECT slug FROM tenants WHERE slug IN ('"'"'hospitality-group'"'"', '"'"'other-co-test'"'"') ORDER BY slug"'
# Expect: 2 rows.

# 2. Unit tests + lint + typecheck clean
pnpm -r typecheck && pnpm lint && pnpm -r test
```

### CI verification (the actual deliverable)

PR to `staging` triggers CI. New `e2e` job runs in parallel after `check` succeeds:
1. Start postgres service (~5s)
2. Install deps + Playwright Chromium (~30s)
3. Hosts + migrate + seed + Inngest CLI background (~15s)
4. Platform E2E (~30-60s, 5 tests)
5. Storefront E2E (~90-150s, 9 active tests across 2 spec files)
6. Upload Playwright HTML report regardless of outcome (artifact retention 7 days)

Total CI overhead: ~3-5min. Bar: the job must be green.

### Promotion verification

After merge to staging, the staging → main promotion PR re-runs CI on the same code. Green = ship.

## Out of scope (deferred)

- Full OTP code-entry roundtrip (needs readback mechanism)
- Google OAuth E2E (needs test-double; DEL-12 `test.skip` stays)
- OTP rate-limit E2E (DEL-9 brings its own)
- Slug convergence between `other-co-test` (DEL-8 seed) and `other-co-del3-test` (storefront-tenant-scoping.spec.ts beforeAll)
- Nightly Neon-branch job for Neon-parity coverage (file if Neon-specific bug ever bites)
