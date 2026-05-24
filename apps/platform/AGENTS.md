# Platform App — AGENTS.md

> Local conventions and context for `apps/platform`.
> Read /AGENTS.md at the root FIRST.

## What this app is

Admin panel for platform staff and tenant operators (restaurant owners, managers).

- URL: `admin.yourapp.com` (production), `localhost:3000` (dev)
- Audience: NOT end users / guests
- Auth: Better-Auth instance #1, email/password + Google OAuth, NO OTP

## Structure

```
src/
├── app/
│   ├── (auth)/           ← Public auth routes
│   │   ├── login/
│   │   ├── signup/
│   │   ├── forgot-password/
│   │   ├── reset-password/
│   │   └── verify-email/
│   ├── (dashboard)/      ← Protected admin routes
│   │   ├── layout.tsx    ← Checks session, redirects if no auth
│   │   ├── page.tsx      ← Dashboard home
│   │   └── tenants/
│   ├── api/auth/[...all] ← BA route handler
│   ├── layout.tsx
│   └── page.tsx          ← Redirects to /dashboard
├── components/
│   ├── auth/             ← Login form, signup form, etc.
│   └── layout/           ← Header, nav, etc.
├── lib/
│   ├── auth.ts           ← Server-side BA instance (re-export)
│   └── auth-client.ts    ← Client-side BA helpers
└── middleware.ts         ← Session check, redirect to /login
```

## Conventions

- Server components by default. `'use client'` only for forms and interactive UI.
- Route protection: handled in middleware (cookie check) + layout (full session check).
- Don't query DB from client components. Use server actions or RSC.
- Forms use react-hook-form + zod for validation.

## Working on auth flows

1. Read `/docs/auth-spec.md` first
2. Read this app's existing auth components
3. Check `@rp/auth-core/platform` for BA config
4. Propose plan before writing code

## Gotchas

- Cookie scope: `Domain=admin.yourapp.com` only. NEVER wildcard.
- Better-Auth route handler at `api/auth/[...all]` — don't move it.
- `headers()` is async in Next.js 15. Always await.
