# Auth Architecture — Spec v3

**Last updated:** 2026-05-23
**Status:** Draft, ready for schema implementation
**Owner:** Vlad

---

## 1. Problem

Building B2B2C white-label restaurant SaaS. Three user populations with strict identity boundaries. Any leak across boundaries = security incident or product churn.

## 2. Domain Model

```
Tenant (business entity, billing unit)
  ├── Locations (physical kitchens, addresses)
  ├── Brands (customer-facing identities, branding)
  └── LocationBrands (M:N — dark kitchen support)
```

**Example:** Tenant "Hospitality Group LLC" owns Kitchen-5th-Ave and Kitchen-Sunset (locations) and Pizza Express, Burger Heaven, Sushi Spot (brands). Pizza Express is served from both kitchens; Burger Heaven only from Kitchen-5th-Ave (dark kitchen).

## 3. User Populations & Identity Spaces

| Population | Identity space | Email uniqueness | Storage |
|---|---|---|---|
| Platform staff | Global | Globally unique | `platform_users` |
| Tenant staff | Global (same table) | Globally unique | `platform_users` + `tenant_memberships` |
| **End users** | **Tenant-scoped** | Unique per tenant | `tenant_end_users` |

**Critical invariant:** the same email `john@x.com` can exist as separate end-user accounts under different *tenants*, but is a single account *within* a tenant (across all that tenant's brands).

**Cross-brand recognition disclosure:** Storefront signup page must clearly disclose: "{Brand Name} is part of {Tenant Name}'s family of restaurants. Your account works across all our brands." Required for GDPR/CCPA compliance and customer trust.

## 4. Auth Methods (DECIDED — Variant A, Passwordless for end users)

| Population | Primary | Alternative | Excluded |
|---|---|---|---|
| Platform users | Email + password | Google OAuth | OTP, magic links, MFA (v1) |
| End users | **Email OTP (6-digit, 10min TTL)** | Google OAuth | Password, phone/SMS OTP |

**Why passwordless for end users:**
- Restaurant guests log in infrequently (every 2-4 weeks) — they will forget any password
- 2026 industry consensus: passwordless is the modern standard for new consumer apps
- NIST has deprecated SMS OTP; email OTP is current-best baseline
- v2 upgrade path: prompt passkey enrollment after first OTP login (industry-standard phased migration)
- Lower code surface = fewer bugs = fewer support tickets

**Why password for platform users:**
- Daily login frequency makes OTP friction unbearable
- Sophisticated users expect password managers
- Google OAuth covers the "easy login" case

## 5. Architecture

**Monorepo with two Next.js applications:**

```
apps/
  platform/      → admin.yourapp.com
                   (platform staff + tenant staff)
  storefront/    → {brand-slug}.yourapp.com
                   (end users, tenant-scoped identity, brand-themed UI)
packages/
  db/            → shared Drizzle schema
  auth-core/     → shared auth utilities
  ui/            → shared shadcn-based design system
```

**Why two apps:** security boundary = network boundary. Cookies on `admin.*` cannot leak to `*.yourapp.com` storefronts by design. Cannot be undone by a bug in an `if` statement.

## 6. Acceptance Criteria

1. End user `john@x.com` can have separate accounts at tenant A and tenant B. Sessions and logins on one do not affect the other.
2. End user `john@x.com` has ONE account at tenant A, usable across all brands of tenant A. Logging in at `pizza-express.yourapp.com` and `burger-heaven.yourapp.com` (same tenant) resolves to same `tenant_end_user_id`.
3. Platform staff login at `admin.yourapp.com` via email/password or Google. Session: 7d inactivity / 30d absolute max.
4. End user login at `{brand}.yourapp.com` via email OTP (6-digit, 10min TTL) or Google. Session: 30d inactivity.
5. End user navigating to `admin.yourapp.com` sees generic 404, never an authorized/unauthorized leak.
6. Tenant staff querying brand they don't have membership for → 404, never 403.
7. Tenant soft-delete: 30-day grace → hard-delete cascades to locations, brands, tenant_end_users.
8. OTP rate limits: 1 request per 60s per email per tenant; 5 failed attempts → 15min cooldown.
9. Platform user password requirements: min 12 chars, bcrypt cost ≥12.
10. Cross-brand UX: when end user first visits a sibling brand (same tenant), disclosure shown: "{Brand} is part of {Tenant}'s family."

## 7. Non-Goals (v1)

- ❌ SSO (SAML / enterprise OIDC)
- ❌ Passkeys / WebAuthn (planned for v2 after first OTP login)
- ❌ MFA for platform users (v2 opt-in)
- ❌ Magic links (OTP covers passwordless use case)
- ❌ Phone OTP / SMS (Twilio dependency, NIST-deprecated for new deploys)
- ❌ Password for end users (passwordless by design)
- ❌ Custom domains (subdomains only in v1)
- ❌ Brand sale / customer data migration between tenants (manual operation in v1)
- ❌ Cross-tenant account linking (would break tenant-scoped invariant)

## 8. Data Model (overview, full schema in next doc)

```
-- Platform identity
platform_users           id, email UNIQUE, name, email_verified_at, ...
platform_accounts        id, platform_user_id, provider, provider_account_id,
                         hashed_password, oauth_tokens

-- Tenant domain
tenants                  id, slug UNIQUE, name, billing_status, ...
locations                id, tenant_id, name, address, ...
brands                   id, tenant_id, slug UNIQUE, name, branding_json
location_brands          location_id, brand_id (M:N)

-- Tenant membership
tenant_memberships       id, platform_user_id, tenant_id,
                         role (owner|manager|staff|viewer),
                         UNIQUE(platform_user_id, tenant_id)

-- End-user identity (TENANT-scoped)
tenant_end_users         id, tenant_id, email, name, email_verified_at,
                         UNIQUE(tenant_id, email)
tenant_end_user_accounts id, tenant_end_user_id, provider, provider_account_id
                         (oauth only — no hashed_password)

-- Shared
sessions                 id, subject_type (platform|end_user),
                         subject_id, tenant_id, current_brand_id (NULL for platform),
                         expires_at, ip, user_agent
verification_tokens      id, identifier (email), token_hash,
                         type (otp|email_verify|password_reset),
                         tenant_id (NULL for platform), expires_at, attempts
```

**Key DB constraints:**
- `UNIQUE(email)` on `platform_users`
- `UNIQUE(tenant_id, email)` on `tenant_end_users`
- `UNIQUE(slug)` on `tenants` and on `brands`
- All `*_id` FKs with `ON DELETE CASCADE` where ownership applies
- `tenant_end_user_accounts.hashed_password` does NOT exist (passwordless)

## 9. Route Map

**Platform (`admin.yourapp.com`):**
```
/login                          email/password + Google
/signup                         invite-only (?token=...)
/forgot-password                email → reset link
/reset-password?token=
/verify-email?token=
/oauth/callback/google
/logout
/dashboard                      auth required
/tenants/[slug]/...             tenant context
```

**Storefront (`{brand-slug}.yourapp.com`):**
```
/                               public, brand-themed landing
/login                          email input → /verify-otp
/verify-otp                     6-digit code input + resend
/oauth/callback/google
/signup                         email + name → /verify-otp
/account                        auth required
/orders                         auth required
/logout
```

## 10. Cross-Brand Recognition UX (tenant-scoped specific)

**Scenario:** John has account at Pizza Express. Visits Burger Heaven (same tenant) for first time.

**Flow:**
1. John lands on `burger-heaven.yourapp.com/login`
2. Enters email `john@x.com`
3. Backend: resolve brand → tenant; lookup `(tenant_id, email)` in `tenant_end_users`
4. Found existing record!
5. UI shows: "Welcome back! We've sent a code to john@x.com. (Burger Heaven is part of {Tenant Name}'s family of brands — your account works here too.)"
6. OTP sent (email branded as Burger Heaven for context)
7. After verification → session with `tenant_end_user_id=existing`, `current_brand_id=burger_heaven`

**Do NOT:**
- Auto-login without OTP across brands (security risk + confuses user)
- Hide the cross-brand relationship (GDPR violation, breaks trust)
- Pre-fill name/data from sibling brand without explicit consent

## 11. Edge Cases

1. **Same email, different tenants:** John at Tenant A AND Tenant B. Two independent accounts. Test: integration test creates both, confirms OTP for one doesn't unlock the other.
2. **Same email, same tenant, multiple brands:** John at Pizza Express AND Burger Heaven (same tenant). ONE account, works across both. Cross-brand disclosure shown.
3. **Same email, platform + end user:** John is owner of Tenant A AND end-user guest of Tenant B. Different apps, different domains, different sessions, never overlap.
4. **Tenant delete cascade:** soft-delete → 30d → hard-delete locations, brands, tenant_end_users, memberships. Platform_user records persist.
5. **OAuth account linking:** end user signed up via OTP and later logs in via Google with same email → auto-link **only if** Google `email_verified=true` AND we already verified OTP-side email. Otherwise prompt explicit consent.
6. **Email change:** new + old email both receive notification (security best practice).
7. **Cookie scoping:** `Domain=admin.yourapp.com` (NOT `*.yourapp.com`), `SameSite=Lax`, `Secure`, `HttpOnly`. Storefront cookies scoped to `{brand}.yourapp.com` only.
8. **OTP rate limit storage:** Redis counter with sliding window (`otp:request:{tenant_id}:{email}` and `otp:fail:{tenant_id}:{email}:{token_id}`).
9. **Signup race condition:** two concurrent requests with same (tenant_id, email). DB constraint is source of truth; handle violation as "already registered".
10. **Tenant member removed:** find all active sessions for that platform_user under this tenant → delete sessions.
11. **OTP brute force:** 5 fails → 15min cooldown; token TTL 10min.
12. **Brand slug collision:** two tenants want slug `pizza`. First-come-first-served, second gets validation error.
13. **OTP issued at Pizza Express, used at Burger Heaven (same tenant):** technically valid (same `verification_tokens` row), but session brand context is set by the brand on which verification was completed. UI should keep the user on the brand they started on.

## 12. Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Cross-tenant end-user data leak via query bug | Medium | Critical | DB UNIQUE constraint + integration tests for cross-tenant access + Postgres RLS as defense-in-depth |
| Hashed password storage compromised (platform) | Low | Critical | bcrypt cost ≥12; passwords never logged; rotation policy |
| Google OAuth `email_verified` trusted blindly | Low | High | Always re-verify on first link; document trust boundary |
| Subdomain takeover → session hijack | Low | High | Subdomains only on owned DNS; cookies scoped to exact subdomain |
| OTP delivery delays during traffic spikes | Medium | Medium | Resend mechanism; visible TTL countdown in UI; fallback to Google OAuth |
| Customer confused by cross-brand recognition | Medium | Low | Explicit disclosure on signup + first cross-brand login |
| Brand sale (v2) — customer data migration complexity | Medium | High | Out of scope v1; document need for v2 |

## 13. UI Foundation

All auth screens built on shadcn/ui blocks:
- Login: https://ui.shadcn.com/blocks/login (centered card variant)
- Signup: https://ui.shadcn.com/blocks/signup
- OTP step: shadcn `InputOTP` component, 6 slots, auto-submit on completion
- Consistent layout across platform and storefront, themed per-brand at storefront

## 14. Decisions Log

| Date | Decision | Reasoning |
|---|---|---|
| 2026-05-23 | Better-Auth, not Clerk | Per-MAU pricing kills B2B2C unit economics; self-host requirement |
| 2026-05-23 | Two Next.js apps, not one | Network boundary > if-statement boundary |
| 2026-05-23 | Passwordless for end users (OTP + OAuth) | 2026 industry consensus; restaurant guests rarely log in; NIST guidance; less code |
| 2026-05-23 | Tenant-scoped end users (not brand-scoped) | Unified customer base across brands; tenant-wide loyalty; matches multi-unit chain operator expectations |
| 2026-05-23 | Cross-brand disclosure required | GDPR/CCPA compliance; customer trust; avoids "creepy" surprise |
| 2026-05-23 | Subdomain `{brand}.yourapp.com` in v1 | Custom domains add SSL + cookie complexity; v2 problem |
| 2026-05-23 | Single `sessions` table with discriminator | Simpler queries, easier observability |
| 2026-05-23 | OTP via email only in v1 | NIST deprecates SMS OTP; phone OTP not justified |
| 2026-05-23 | Passkeys deferred to v2 | Phased migration: OTP first, then enrollment prompt post-login |

---

## Next steps

1. ✅ Spec v3 (this document)
2. ⏭ Drizzle schema (full table definitions, indexes, FKs, with reasoning per field)
3. ⏭ Better-Auth configuration for both apps
4. ⏭ Tenant resolution middleware (subdomain → brand_id → tenant_id)
5. ⏭ Implementation: platform auth flow
6. ⏭ Implementation: storefront auth flow with cross-brand recognition
7. ⏭ Integration tests (edge cases §11)
