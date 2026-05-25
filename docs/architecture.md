# Architecture Overview

## High-level

```
                ┌─────────────────────────┐
                │   Vercel Edge Network   │
                └───────────┬─────────────┘
                            │
                ┌───────────┴─────────────┐
                │                         │
        ┌───────▼────────┐       ┌────────▼─────────┐
        │ admin.app.com  │       │ {brand}.app.com  │
        │ Platform App   │       │ Storefront App   │
        │ Next.js 15     │       │ Next.js 15       │
        │                │       │                  │
        │ - Staff        │       │ - Guests         │
        │ - Tenant ops   │       │ - Brand-themed   │
        │ - Better-Auth  │       │ - Tenant scoped  │
        │   instance #1  │       │ - Better-Auth #2 │
        └───────┬────────┘       └────────┬─────────┘
                │                         │
                └───────────┬─────────────┘
                            │
                ┌───────────▼─────────────┐
                │  Neon Postgres          │
                │  (shared schema)        │
                └─────────────────────────┘
```

## Three user populations

| Population | Identity | App | Auth methods |
|---|---|---|---|
| Platform staff | Global `platform_users` | Platform | Email/Password, Google OAuth |
| Tenant staff | Same table + memberships | Platform | Same as above |
| End users | Tenant-scoped `tenant_end_users` | Storefront | OTP, Email/Password, Google OAuth |

**Identity boundary:** end users at Tenant A and Tenant B are different accounts. End users across brands of *one tenant* are the same account (cross-brand recognition with disclosure).

## Tenant domain model

```
Tenant
  ├── Locations           (physical kitchens)
  ├── Brands              (customer-facing identities, subdomains)
  ├── location_brands     (M:N — dark kitchen support)
  ├── tenant_memberships  (platform users with roles)
  └── tenant_end_users    (guests, scoped to tenant)
```

A tenant can operate multiple kitchens (locations) and run multiple brands (consumer-facing names). The M:N join `location_brands` supports dark kitchens where one kitchen serves multiple brands.

## Request flow: storefront login

```
1. Guest visits pizza-express.deliverse.app/login
2. proxy.ts: extract "pizza-express" from Host header
3. proxy.ts: inject x-brand-slug header
4. Server component / layout: getBrandContext("pizza-express")
   → DB lookup brand + tenant
5. Render brand-themed login form
6. User submits email
7. emailOtp.sendVerificationOtp() — Better-Auth issues OTP
8. Resend delivers email (brand-themed template)
9. User enters code on /verify-otp
10. emailOtp.signIn() — Better-Auth verifies, creates session
11. Session row: tenant_end_user_id + current_brand_id
12. Redirect to /account
```

## Why two Next.js apps (not one)

- **Network boundary > if-statement boundary.** Cookies on `admin.*` are physically scoped — impossible to leak to storefronts via code bug.
- **Different audiences, different UX.** Platform is dense admin UI; storefront is consumer-facing branded experience.
- **Independent deploys.** Platform changes don't risk breaking customer-facing pages and vice versa.
- **Different auth flows.** Two Better-Auth instances with different methods.

## Shared concerns

- **`packages/db`** — single Drizzle schema, shared client.
- **`packages/ui`** — shadcn components (each app can override theme).
- **`packages/auth-core`** — Better-Auth configs (one per app).
- **`packages/typescript-config`** — base tsconfigs.

## Deployment topology

| Component | Where | Why |
|---|---|---|
| Platform app | Vercel | Next.js native, edge caching |
| Storefront app | Vercel | Same |
| Database | Neon | Serverless Postgres, branches for previews |
| Email | Resend | Best deliverability for transactional |
| Jobs/Events | Inngest | Event-driven async work |
| Analytics | PostHog | Product analytics + flags + session replay |
| Errors | Sentry | Standard, well-debugged |

## Failure boundaries

- **DB down:** apps show error pages; no requests proceed. Better-Auth refuses login.
- **Email provider down:** OTP can't be sent. Inngest retries with exponential backoff. UI shows "try again in a moment".
- **Inngest down:** events queued in-memory by Inngest client until reconnected (limited buffer).
- **OAuth provider down:** users use password / OTP fallback.

## Security posture

- Cookies: `Secure`, `HttpOnly`, `SameSite=Lax`, scoped to exact subdomain.
- Passwords: bcrypt cost ≥12, never logged.
- OTPs: stored hashed, 10min TTL, 5 attempts then lockout.
- Sessions: server-side stored, revocable.
- No secrets in code. All in env vars, validated at boot via zod.
- Cross-tenant queries impossible: DB constraints + integration tests.
- All identity boundaries documented in `docs/auth-spec.md` §3.
