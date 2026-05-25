# Storefront App — AGENTS.md

> Local conventions for `apps/storefront`.
> Read /AGENTS.md at the root FIRST.

## What this app is

Customer-facing storefront for restaurant guests.

- URL: `{brand-slug}.deliverse.app` (production), `{brand-slug}.localhost:3001` (dev)
- Audience: end users / guests
- Auth: Better-Auth instance #2, email OTP (primary) + password + Google OAuth

## Critical: tenant resolution

Every request goes through `src/middleware.ts` which:
1. Parses brand slug from Host header
2. Validates the brand exists
3. Injects `x-brand-slug` header for server components

Server components use `getBrandContext(slug)` from `@/lib/tenant-resolution`
to get the full brand + tenant context (DB-backed, request-cached).

**NEVER hardcode brand or tenant IDs.** Always derive from the request.

## Auth flow (hybrid)

1. User enters email
2. Default path: OTP request → /verify-otp → enter code → logged in
3. Alternative: toggle "Sign in with password" → password field appears
4. Alternative: "Continue with Google" → OAuth flow

After successful auth:
- Session is created with `tenant_end_user_id` + `current_brand_id`
- User redirected to `/account` or `next` param

## Structure

```
src/
├── app/
│   ├── (auth)/
│   │   ├── login/
│   │   ├── signup/
│   │   └── verify-otp/
│   ├── (shop)/         ← Public storefront pages
│   ├── account/        ← Protected: user's account
│   ├── orders/         ← Protected: user's orders
│   └── api/auth/[...all]
├── components/
│   ├── auth/
│   ├── brand/          ← Brand-themed components
│   └── layout/
├── lib/
│   ├── auth.ts
│   ├── auth-client.ts
│   └── tenant-resolution.ts  ← Subdomain → brand → tenant
└── middleware.ts
```

## Local dev setup

The brand subdomain works via `/etc/hosts` or with `*.localhost`:

```bash
# Option 1: /etc/hosts
echo "127.0.0.1 pizza-express.localhost burger-heaven.localhost" | sudo tee -a /etc/hosts

# Option 2: Some browsers (Chrome, Firefox recent) auto-resolve *.localhost.
# Then visit http://pizza-express.localhost:3001
```

Seed data creates the test brands `pizza-express` and `burger-heaven`.

## Gotchas

- Cookies scoped to exact subdomain — DO NOT use wildcard `.deliverse.app`.
- OTP email branding must include brand context (logo, name) — passed from request.
- Cross-brand recognition: when user from `pizza-express` (Tenant X) visits `burger-heaven` (also Tenant X), show disclosure: "Burger Heaven is part of {Tenant Name}'s family — your account works here."
- `headers()` is async. Always await.
