# Storefront App — AGENTS.md

> Local conventions for `apps/storefront`.
> Read /AGENTS.md at the root FIRST.

## What this app is

Customer-facing storefront for restaurant guests.

- URL: `{storefront-slug}.deliverse.app` (production), `{storefront-slug}.localhost:3001` (dev)
- Audience: end users / guests
- Auth: Better-Auth instance #2, email OTP (primary) + password + Google OAuth
- **Three modes** per [ADR-0012](../../docs/decisions/0012-storefront-brand-tenant-food-hall-architecture.md):
  1. **Mode 1** — single-brand tenant. `{brand-slug}.deliverse.app` renders the brand's menu directly at `/`.
  2. **Mode 2** — multi-brand tenant with separate brand storefronts. Same as mode 1 from the storefront's perspective: each brand has its own subdomain.
  3. **Mode 3** — food hall. `{tenant-slug}.deliverse.app` renders a directory of the tenant's brands; users navigate into `/b/<brand-slug>` for the brand's menu. Cart spans brands within tenant.

## Critical: storefront resolution

Every request goes through `src/proxy.ts` which:
1. Parses storefront slug from Host header.
2. Resolves slug → `{ storefrontId, storefrontType, tenantId, brandId? }` via the `storefronts` table.
3. Injects `x-storefront-id`, `x-storefront-type`, `x-storefront-name` headers (always) and `x-brand-slug` (only when `type='brand'`).

Server components use:
- `getStorefrontContext()` from `@/lib/tenant-resolution` — page-friendly resolver returning the full storefront context (cached per request, returns `null` instead of throwing on malformed requests so pages can `notFound()`).
- `getBrandContext(slug)` from `@/lib/tenant-resolution` — brand + tenant detail for a specific brand slug (used when rendering brand subsections + mode 1/2 home).

**NEVER hardcode brand or tenant IDs.** Always derive from the request.

## Brand theming (DEL-25)

Per-brand theming is applied via inline CSS-variable override on a wrapper div, using `brandThemeStyle` from `@/lib/brand-theme`:

```tsx
<div style={brandThemeStyle(brand.brandingJson)}>{children}</div>
```

Tailwind v4's `@theme` block (`packages/ui/src/styles/globals.css`) exposes `--color-primary`, `--color-secondary`, etc. as CSS custom properties on `:root`. Setting them on a descendant element overrides them for that subtree — every `bg-primary` / `text-primary` / `ring-primary` utility on descendants reads the brand-specific value automatically.

**Where brand theming applies:**
- Mode 1/2 brand storefront home (`(shop)/page.tsx` when `storefrontType==='brand'`).
- Mode 3 brand subsections (`(shop)/b/[brandSlug]/page.tsx`).

**Where it does NOT apply (uses tenant defaults):**
- Mode 3 food-hall shell (`(shop)/page.tsx` when `storefrontType==='tenant'`) — per AC#6, the directory is tenant-themed, not brand-themed.

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
│   ├── (shop)/                 ← Public storefront pages
│   │   ├── page.tsx            ← branches on storefrontType (directory or menu)
│   │   └── b/[brandSlug]/      ← brand subsection inside a food hall (DEL-25)
│   ├── account/                ← Protected: user's account
│   ├── orders/                 ← Protected: user's orders (DEL-25 PR 25c)
│   └── api/auth/[...all]
├── components/
│   ├── auth/
│   ├── food-hall/              ← Brand directory + brand card (DEL-25)
│   └── menu/                   ← Menu view + menu item card (DEL-25; shared mode 1/2 + mode 3)
├── lib/
│   ├── auth.ts
│   ├── auth-client.ts
│   ├── brand-theme.ts          ← brandThemeStyle CSS-var helper (DEL-25)
│   ├── storefront-tenant-context.ts  ← BA-facing resolver (DEL-22)
│   └── tenant-resolution.ts    ← getStorefrontContext + getBrandContext
└── proxy.ts
```

## Local dev setup

The brand subdomain works via `/etc/hosts` or with `*.localhost`:

```bash
# Option 1: /etc/hosts
echo "127.0.0.1 pizza-express.localhost burger-heaven.localhost" | sudo tee -a /etc/hosts

# Option 2: Some browsers (Chrome, Firefox recent) auto-resolve *.localhost.
# Then visit http://pizza-express.localhost:3001
```

Seed data creates two demo tenants:
- `hospitality-group` (mode 1/2) — `pizza-express.localhost:3001`, `burger-heaven.localhost:3001`.
- `oomi-kitchen-test` (mode 3 — DEL-25) — `oomi-kitchen-test.localhost:3001` (food-hall directory), `oomi-burger-test.localhost:3001` + `oomi-pizza-test.localhost:3001` (brand storefronts for the same tenant).

## Gotchas

- Cookies scoped to exact subdomain — DO NOT use wildcard `.deliverse.app`.
- OTP email branding must include brand context (logo, name) — passed from request.
- Cross-brand recognition: when user from `pizza-express` (Tenant X) visits `burger-heaven` (also Tenant X), show disclosure: "Burger Heaven is part of {Tenant Name}'s family — your account works here."
- `headers()` is async. Always await.
