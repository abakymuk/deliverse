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

## 7. Out of scope (linked tickets)

- **Auto-seed in deploy workflows.** Not done — one-shot manual seeding is safer; auto-seed risks clobbering prod data drift.
- **Storefront-side shared seed user.** Not done — end users sign themselves up; no shared identity.
- **Cross-tenant E2E test harness.** Tracked in [DEL-8](https://linear.app/oveglobal/issue/DEL-8) (multi-tenant seed + Playwright config + CI integration). Several `test.skip` placeholders in `apps/storefront/tests/e2e/storefront-tenant-scoping.spec.ts` reference this gap.
- **Vercel wildcard binding for `*.{staging,}.deliverse.app`.** Pre-existing gap from DEL-7. Blocks `burger-heaven.{staging,}.deliverse.app` reachability. Worth a dedicated ticket before launching more brands.
