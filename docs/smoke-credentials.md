# Smoke credentials + recipes

How to run auth-gated smokes against staging and production without burning 40 minutes guessing passwords or fighting shell quoting. Lessons paid for in DEL-13's stg + prd shipping.

---

## 1. Where the admin password lives

`admin@test.local` is the seeded tenant-owner on platform (`packages/db/src/seed.ts:33-46`). Its password is stored in Doppler per-env under `SEED_ADMIN_PASSWORD`. **Never** hardcode it; **never** guess it; **never** check it into the repo.

```bash
# Look it up (read-only):
doppler secrets --config stg get SEED_ADMIN_PASSWORD --plain
doppler secrets --config prd get SEED_ADMIN_PASSWORD --plain

# Rotate (writes new secret + re-seeds; admin signin works immediately after):
NEW_PW=$(openssl rand -hex 16)
doppler secrets set --config stg SEED_ADMIN_PASSWORD="$NEW_PW"
doppler run --config stg -- pnpm db:seed
# (seed uses onConflictDoUpdate as of DEL-16 — no manual DELETE needed)
```

**Stg + prd have distinct secrets.** Rotating one does not affect the other.

---

## 2. BA's CSRF gotcha — `MISSING_OR_NULL_ORIGIN`

Better-Auth's state-changing endpoints (anything other than `/api/auth/sign-in/email`) require an `Origin` header matching the host. A bare `curl -X POST ...` returns `403 MISSING_OR_NULL_ORIGIN`. Signin is exempt because it's the first-contact path.

```bash
# WRONG — 403 MISSING_OR_NULL_ORIGIN
curl -X POST 'https://admin.staging.deliverse.app/api/auth/organization/invite-member' \
  -H 'Content-Type: application/json' -d '{...}'

# RIGHT — add Origin header
curl -X POST 'https://admin.staging.deliverse.app/api/auth/organization/invite-member' \
  -H 'Content-Type: application/json' \
  -H 'Origin: https://admin.staging.deliverse.app' \
  -d '{...}'
```

---

## 3. Inngest events have an indexing delay

`/v1/events` returns empty for ~10–30s after the event fires, even though the function execution + REST API are unaffected per Inngest's [status page](https://status.inngest.com). Poll up to 60s before declaring it missing.

```bash
# Polling pattern — exit on first match, up to 60s
EMAIL="<recipient-from-the-event-data>"
for i in 1 2 3 4 5 6; do
  OUT=$(doppler run --config stg -- bash -c '
    curl -sS -H "Authorization: Bearer $INNGEST_SIGNING_KEY" \
      "https://api.inngest.com/v1/events?event_name=<event-name>&limit=5"
  ')
  if echo "$OUT" | grep -q "$EMAIL"; then
    echo "=== FOUND attempt $i ==="
    echo "$OUT" | python3 -m json.tool
    break
  fi
  echo "attempt $i: not yet, waiting 10s"; sleep 10
done
```

Same `INNGEST_SIGNING_KEY` works for both function-webhook auth + events API. No separate API token needed; account/environment routing is automatic per Doppler config.

---

## 4. 3-step invite smoke recipe (canonical)

Tested end-to-end on stg + prd during DEL-13. Use this exact shape for any future platform invite-flow smoke.

```bash
# === Setup (lookup tenant by slug — never hardcode UUIDs) ===
COOKIE_JAR=/tmp/smoke.cookies
ENV=stg   # or prd
HOST="https://admin.${ENV/prd/}staging.deliverse.app"   # crude — see below
[ "$ENV" = prd ] && HOST="https://admin.deliverse.app"

TENANT_ID=$(doppler run --config $ENV -- bash -c '
  psql "$DATABASE_URL" -t -A -c "SELECT id FROM tenants WHERE slug='\''hospitality-group'\''"
' | tr -d '[:space:]')

ADMIN_PW=$(doppler secrets --config $ENV get SEED_ADMIN_PASSWORD --plain)

TS=$(date +%s); INVITEE="smoke-${ENV}-${TS}@example.com"
echo "Inviting $INVITEE to tenant $TENANT_ID on $HOST"

# === Step 1: signin as admin@test.local (saves cookie) ===
curl -sS -c "$COOKIE_JAR" -X POST "$HOST/api/auth/sign-in/email" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"admin@test.local\",\"password\":\"$ADMIN_PW\"}" \
  -w '\nHTTP %{http_code}\n' > /dev/null && echo "✓ signin"

# === Step 2: invite (cookie + Origin header) ===
curl -sS -b "$COOKIE_JAR" -X POST "$HOST/api/auth/organization/invite-member" \
  -H 'Content-Type: application/json' \
  -H "Origin: $HOST" \
  -d "{\"email\":\"$INVITEE\",\"role\":\"staff\",\"organizationId\":\"$TENANT_ID\"}" \
  -w '\nHTTP %{http_code}\n'

# === Step 3: pull Inngest event (with polling for indexing delay) ===
sleep 8
doppler run --config $ENV -- bash -c '
  curl -sS -H "Authorization: Bearer $INNGEST_SIGNING_KEY" \
    "https://api.inngest.com/v1/events?event_name=email.invitation.requested&limit=3"
' | python3 -m json.tool
```

Expected payload: `data.url = "$HOST/signup?token=<uuid>"`, `data.organizationName = "Hospitality Group"`, `data.role = "staff"`.

---

## 5. Storefront signup smoke (no admin needed)

Storefront end-users sign themselves up (no shared seeded user). Used by DEL-12 + DEL-15 + DEL-13 stg/prd smokes.

```bash
ENV=stg
HOST="https://pizza-express.staging.deliverse.app"
[ "$ENV" = prd ] && HOST="https://pizza-express.deliverse.app"

TS=$(date +%s); EMAIL="smoke-${ENV}-${TS}@example.com"

# Email/password signup — autoSignIn: true, no email verify
curl -sS -X POST "$HOST/api/auth/sign-up/email" \
  -H "Content-Type: application/json" \
  -H "Origin: $HOST" \
  -d "{\"email\":\"$EMAIL\",\"password\":\"Smoke-2026-Pass-1\",\"name\":\"Smoke User\"}" \
  -w "\nHTTP %{http_code}\n"

# Trigger password reset (DEL-15: URL host should be brand subdomain, not platform)
curl -sS -X POST "$HOST/api/auth/request-password-reset" \
  -H 'Content-Type: application/json' \
  -H "Origin: $HOST" \
  -d "{\"email\":\"$EMAIL\",\"redirectTo\":\"/reset-password\"}" \
  -w '\nHTTP %{http_code}\n'

# Verify the reset event URL via Inngest REST API (poll if needed)
doppler run --config $ENV -- bash -c '
  curl -sS -H "Authorization: Bearer $INNGEST_SIGNING_KEY" \
    "https://api.inngest.com/v1/events?event_name=email.password_reset.requested&limit=3"
' | python3 -m json.tool
```

Expected `data.url` host = the brand subdomain you signed up at.

---

## 6. Smoke residue cleanup

Smokes leave real DB rows. They're harmless (RFC 2606 `@example.com` bounces) but accumulate. Periodic cleanup if desired:

```bash
ENV=stg
doppler run --config $ENV -- bash -c '
  psql "$DATABASE_URL" -c "
    SELECT COUNT(*) AS smoke_rows
    FROM tenant_end_users
    WHERE email LIKE '\''smoke-%@example.com'\'';
  "
'

# Delete (cascades to sessions/accounts/verifications via FK ON DELETE CASCADE):
# doppler run --config $ENV -- bash -c '
#   psql "$DATABASE_URL" -c "DELETE FROM tenant_end_users WHERE email LIKE '\''smoke-%@example.com'\''"
# '
```

---

## 7. Google OAuth client setup (Phase 3 M2)

BA's `socialProviders.google` block in [`packages/auth-core/src/storefront.ts`](../packages/auth-core/src/storefront.ts) wires the storefront end-user Google OAuth. The wiring is complete — the only thing blocking real handshakes is the `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` env vars being unset in every environment.

Google requires **exact-match** redirect URIs per the [OAuth 2.0 web-server docs](https://developers.google.com/identity/protocols/oauth2/web-server). **No wildcards.** Every concrete storefront subdomain × env must be listed individually on the client.

### 7.1 Redirect URIs per env

Use **three separate OAuth 2.0 clients** (one per env). Each lists exactly its env's five redirect URIs:

**Dev (`localhost:3001`)** — OAuth client `Deliverse storefront — dev`:

```
http://pizza-express.localhost:3001/api/auth/callback/google
http://burger-heaven.localhost:3001/api/auth/callback/google
http://oomi-kitchen-test.localhost:3001/api/auth/callback/google
http://oomi-burger-test.localhost:3001/api/auth/callback/google
http://oomi-pizza-test.localhost:3001/api/auth/callback/google
```

**Staging (`staging.deliverse.app`)** — OAuth client `Deliverse storefront — stg`:

```
https://pizza-express.staging.deliverse.app/api/auth/callback/google
https://burger-heaven.staging.deliverse.app/api/auth/callback/google
https://oomi-kitchen-test.staging.deliverse.app/api/auth/callback/google
https://oomi-burger-test.staging.deliverse.app/api/auth/callback/google
https://oomi-pizza-test.staging.deliverse.app/api/auth/callback/google
```

**Production (`deliverse.app`)** — OAuth client `Deliverse storefront — prd`:

```
https://pizza-express.deliverse.app/api/auth/callback/google
https://burger-heaven.deliverse.app/api/auth/callback/google
https://oomi-kitchen-test.deliverse.app/api/auth/callback/google
https://oomi-burger-test.deliverse.app/api/auth/callback/google
https://oomi-pizza-test.deliverse.app/api/auth/callback/google
```

**Total: 15 exact URIs** (5 per env × 3 envs). `SEED_TEST_FIXTURES`-only storefronts (`other-brand-test`, `solo-cafe-test`) are excluded — they don't ship to stg/prd seeds. **If any new storefront ships to prd, its `/api/auth/callback/google` URI must be added to the prd client before the BA `socialProviders.google` accepts requests at that subdomain.**

The platform app (`admin.deliverse.app`) does NOT participate in this client set — its Google OAuth is for tenant operators and lives on a separate BA instance. If platform-side Google OAuth ever ships, give it its own OAuth client per env.

### 7.2 OAuth client IDs (non-secret, safe to commit)

Filled in after the clients are created in [Google Cloud Console → APIs & Services → Credentials](https://console.cloud.google.com/apis/credentials):

| Env | Client ID | Notes |
|---|---|---|
| dev | `<TODO — fill after creating>` | |
| stg | `<TODO — fill after creating>` | |
| prd | `<TODO — fill after creating>` | |

Client secrets live in Doppler **only** — never commit them, never paste them in chat:

```bash
doppler secrets set --config dev GOOGLE_CLIENT_ID="<dev-client-id>"
doppler secrets set --config dev GOOGLE_CLIENT_SECRET="<dev-secret>"
doppler secrets set --config stg GOOGLE_CLIENT_ID="<stg-client-id>"
doppler secrets set --config stg GOOGLE_CLIENT_SECRET="<stg-secret>"
doppler secrets set --config prd GOOGLE_CLIENT_ID="<prd-client-id>"
doppler secrets set --config prd GOOGLE_CLIENT_SECRET="<prd-secret>"
```

Confirm the env vars made it through the Turbo `globalEnv` allowlist — both keys are already in [`turbo.json`](../turbo.json) `globalEnv`. Without that allowlist entry, Turbo silently strips the env var before the app process reads it, and BA's `socialProviders.google` would see empty strings — verify with `grep -E 'GOOGLE_CLIENT' turbo.json` before relying on them.

### 7.3 Google Cloud Console ops checklist

Per env (dev / stg / prd):

1. **Create OAuth 2.0 Client ID** under the right Google Cloud project.
   - Application type: **Web application**.
   - Name: `Deliverse storefront — <env>`.
2. **Authorized redirect URIs**: paste the 5 URIs for this env from § 7.1 verbatim. Google enforces case + scheme exactly — copy them, don't retype.
3. **Authorized JavaScript origins**: leave empty (BA's google provider does the server-side auth-code flow; in-browser origins are only needed for client-side flows we don't use).
4. **Download / copy** the client ID + client secret. Set both in Doppler per § 7.2.
5. **Update this doc** with the client ID (non-secret) in the § 7.2 table.

Repeat for the other two envs. Each env gets its OWN client — sharing a client across envs would couple redirect-URI list management and complicate revocation.

### 7.4 Per-env manual smoke (canonical)

Tested end-to-end after each env's client is wired. **Don't promote stg → prd before stg's smoke passes** (per AGENTS.md § Environments hard rule #1).

For each env, pick one brand subdomain (e.g., `pizza-express`) and run:

```bash
ENV=stg                                  # or dev / prd
BRAND=pizza-express
HOST="https://${BRAND}.${ENV/prd/}staging.deliverse.app"
[ "$ENV" = prd ] && HOST="https://${BRAND}.deliverse.app"
[ "$ENV" = dev ] && HOST="http://${BRAND}.localhost:3001"
```

**Manual (browser):**

1. Open `$HOST/login` (or `/signup`) in a private/incognito window — clean cookie state.
2. Click **Continue with Google**. Browser redirects to `accounts.google.com/o/oauth2/auth?...`.
3. Complete the Google handshake with a **fresh** account (or one not previously linked to this tenant — same-Google-account-different-tenant is allowed by [DEL-12](https://linear.app/oveglobal/issue/DEL-12) and is what Step 5 / DEL-12 e2e tests, but you want a clean first-link smoke).
4. Browser lands at `$HOST/account` (or `/?next=<original>` if a `next` param was set) with a populated session.

**DB verification (the proof):**

```bash
ENV=stg                                  # match the manual env
GOOGLE_EMAIL="<the-account-you-signed-in-with>@gmail.com"

doppler run --config $ENV -- bash -c '
  psql "$DATABASE_URL" -c "
    SELECT
      a.provider_id,
      a.account_id,
      a.tenant_id,
      t.slug AS tenant_slug,
      u.email
    FROM tenant_end_user_accounts a
    JOIN tenant_end_users u ON u.id = a.tenant_end_user_id
    JOIN tenants t ON t.id = a.tenant_id
    WHERE u.email = '\'"$GOOGLE_EMAIL"\''
      AND a.provider_id = '\''google'\''
      AND a.deleted_at IS NULL
    ORDER BY a.created_at DESC
    LIMIT 5;
  "
'
```

Expected: one row where `provider_id='google'`, `account_id=<google-uid>` (long numeric string), `tenant_id=<the tenant matching the brand subdomain you signed in at>`. The presence of this row is the proof the full chain works — BA Google provider → OAuth handshake → callback → tenant-scoped `account` create (DEL-12) → `tenant_end_user_accounts` insert with the correct `tenant_id`.

**Cleanup** (the test rows accumulate the same way email/password signup ones do — see § 6):

```bash
doppler run --config $ENV -- bash -c '
  psql "$DATABASE_URL" -c "
    DELETE FROM tenant_end_users
    WHERE email = '\'"$GOOGLE_EMAIL"\''
  "
'
```

Cascade deletes the matching `tenant_end_user_accounts` + `tenant_end_user_sessions` rows.

### 7.5 Failure modes

- **`Error 400: redirect_uri_mismatch`** — Google's most common rejection. Compare the URI in the error page (Google shows the exact value it received) against the § 7.1 list. Common causes: trailing slash, `http` vs `https`, missing port, wrong subdomain. Fix in Google Cloud Console (edit the client), wait ~30s for propagation, retry.
- **`Error 401: invalid_client`** — `GOOGLE_CLIENT_ID` or `GOOGLE_CLIENT_SECRET` missing/wrong in Doppler. Verify with `doppler secrets --config $ENV get GOOGLE_CLIENT_ID --plain`. Restart the dev server / redeploy after setting.
- **Google handshake succeeds, browser lands on a 500** — usually the BA callback throws because the storefront resolver doesn't recognize the host. Check the storefront proxy is bound to the brand subdomain (Vercel wildcard binding gap is a known issue per § 8 — `burger-heaven.{staging,}.deliverse.app` is the canonical victim).
- **Handshake succeeds, but `tenant_end_user_accounts` row has the wrong `tenant_id`** — a tenant-context regression. Run the cross-tenant cookie-isolation tests ([cookie-isolation.spec.ts](../apps/storefront/tests/e2e/cookie-isolation.spec.ts)) — the Phase 3 M1 closure covers the read path; the write path is DEL-12.

---

## 8. Out of scope (linked tickets)

- **Auto-seed in deploy workflows.** Not done — one-shot manual seeding is safer; auto-seed risks clobbering prod data drift.
- **Storefront-side shared seed user.** Not done — end users sign themselves up; no shared identity.
- **Cross-tenant E2E test harness.** Tracked in [DEL-8](https://linear.app/oveglobal/issue/DEL-8) (multi-tenant seed + Playwright config + CI integration). Several `test.skip` placeholders in `apps/storefront/tests/e2e/storefront-tenant-scoping.spec.ts` reference this gap.
- **Vercel wildcard binding for `*.{staging,}.deliverse.app`.** Pre-existing gap from DEL-7. Blocks `burger-heaven.{staging,}.deliverse.app` reachability. Worth a dedicated ticket before launching more brands.
- **DEL-12 cross-tenant Google OAuth e2e test (Phase 3 Step 5 / M2).** Currently `test.skip` at [storefront-tenant-scoping.spec.ts:243](../apps/storefront/tests/e2e/storefront-tenant-scoping.spec.ts) pending the BA hook-override test-double. **Does NOT require this section's real-OAuth setup** — the e2e test uses BA `socialProviders.google.{validateAuthorizationCode, verifyIdToken, getUserInfo}` overrides gated on `BA_OAUTH_TEST_MODE=1` (no real Google handshake). § 7.4's manual smoke is the only place real Google OAuth is exercised.
