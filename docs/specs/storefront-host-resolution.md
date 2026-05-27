# Storefront-aware host resolution (DEL-20) — Spec v1

**Created:** 2026-05-27
**Status:** Draft
**Owner:** Vlad
**Issue:** [DEL-20](https://linear.app/oveglobal/issue/DEL-20)
**ADR:** [0012 — Storefront, Brand, Tenant, and Food Hall Architecture](../decisions/0012-storefront-brand-tenant-food-hall-architecture.md)
**Planning doc:** [`docs/planning/food-hall-architecture-linear-plan.md`](../planning/food-hall-architecture-linear-plan.md) Issue 3
**Prior art:** [`docs/specs/storefronts-model.md`](./storefronts-model.md) (DEL-19 — the additive schema this resolver reads)

---

## Problem

[ADR-0012](../decisions/0012-storefront-brand-tenant-food-hall-architecture.md) declares storefront a first-class entity separate from brand: a URL/shell that may host one brand (`type='brand'`) or one tenant's many brands as a food hall (`type='tenant'`). DEL-19 landed the `storefronts` table additively; the routing/auth/UI layers still resolve hosts to brands, not storefronts. As a result, a tenant-host food hall like `oomi-kitchen.deliverse.app` has nowhere to land — the proxy short-circuits on missing brand, and the home page throws `notFound()` if it doesn't see `x-brand-slug`.

DEL-20 rewires the storefront proxy + auth-core helpers so a Host resolves to a `storefronts` row, exposing the storefront's id, type, name, and (for `type='brand'`) brand id to downstream consumers. Brand-host requests must be byte-identical to today — this is the highest-blast-radius change in M1. Tenant-host requests return 200 from a stub home route; the full food-hall UX is DEL-25.

Better-Auth's storefront resolver and adapter remain brand-required in this issue — the brand-optional refactor is DEL-22 + DEL-23. Strict scope discipline matters here: this issue is about the *routing layer*, not the *identity layer*.

## Users

- **Page handlers (this issue + downstream)** — read `x-storefront-id`, `x-storefront-type`, `x-storefront-name` (always when storefront resolves) and `x-brand-slug` (only when `type='brand'`).
- **DEL-22 / DEL-23 (downstream)** — will replace `extractBrandSlug` in the BA tenant resolver with `extractStorefrontSlug` once the BA adapter goes brand-optional.
- **DEL-25 (downstream)** — replaces the food-hall stub with a real shell (brand directory, multi-brand cart entry point). The stub keeps DEL-25's diff focused on UX rather than routing plumbing.

## Acceptance Criteria

Verbatim from [DEL-20](https://linear.app/oveglobal/issue/DEL-20):

1. **AC#1 (spec):** this spec is written, reviewed, and linked from DEL-20.
2. New `extractStorefrontSlug(host, baseDomain)` in `@rp/auth-core` returns the storefront slug (replaces the brand-only extractor at the API surface; both can coexist during the transition).
3. New `resolveStorefrontBySlug(slug)` returns `{ storefrontId, tenantId, brandId?: string, storefrontType: 'brand' | 'tenant' }`.
4. Storefront proxy injects `x-storefront-id` on every request; continues to inject `x-brand-slug` only when `storefrontType='brand'`.
5. Brand-host requests behave **identically** to today — full M1 e2e suite passes unchanged.
6. Tenant-host requests return HTTP 200 from `/` (stub food-hall page; full UX is DEL-25).
7. Reserved subdomains (`www`, `admin`, `api`, `app`) still bypass storefront resolution.

## Non-Goals

- ❌ Session schema change (`current_brand_id` nullability is DEL-21).
- ❌ Better-Auth resolver / adapter change (DEL-22).
- ❌ Verification `brand_id` stamping change (DEL-23).
- ❌ Commerce schema (DEL-24).
- ❌ Food-hall UI shell — multi-brand cart, brand directory, theming (DEL-25).
- ❌ Admin UI for storefronts.
- ❌ LRU cache for the proxy's storefront lookup (follow-up if perf data shows it's needed).

## Data Model Changes

None. The `storefronts` table from DEL-19 ([`storefronts-model.md`](./storefronts-model.md)) is the data contract. DEL-20 is purely a *consumer* of that table — no schema, no migration, no seed change.

## API Surface

### New helpers in `@rp/auth-core`

```ts
// packages/auth-core/src/storefront-host.ts
export function extractStorefrontSlug(
  host: string | null | undefined,
  baseDomain: string | undefined,
): string | null;
// Same shape and reserved-subdomain semantics as extractBrandSlug; mirrors its
// normalizeDomain handling. Both extractors coexist during DEL-22 transition.

// packages/auth-core/src/storefront-resolver.ts (new)
export type StorefrontContext = {
  storefrontId: string;
  storefrontType: 'brand' | 'tenant';
  storefrontName: string;
  tenantId: string;
  brandId?: string; // present iff storefrontType==='brand'
};

export async function resolveStorefrontBySlug(
  slug: string,
): Promise<StorefrontContext | null>;
// Joined query on (storefronts ⨝ tenants) filtering on live storefront +
// active tenant. Maps primaryBrandId === null → brandId: undefined.
```

Subpath export (`packages/auth-core/package.json`):

```json
"./storefront-resolver": "./src/storefront-resolver.ts"
```

Mirrors the existing `./storefront-host`, `./storefront-tenant-resolver` exports — no root `index.ts` re-export.

### Proxy header contract

Headers the proxy writes (and the only writer of):

| Header | When | Value |
|---|---|---|
| `x-storefront-id` | storefront resolves | `storefronts.id` (UUID) |
| `x-storefront-type` | storefront resolves | `'brand'` \| `'tenant'` |
| `x-storefront-name` | storefront resolves | `storefronts.name` |
| `x-brand-slug` | storefront resolves AND `type='brand'` | `storefronts.slug` (= brand slug post-DEL-19 backfill) |

**Strip-before-branch:** the proxy deletes the four headers from the cloned request headers immediately, before any branching (reserved subdomain, `/api` bypass, no-host, unknown-slug, resolved). The proxy is the only writer; client-supplied versions die on every code path.

### Page contract

`apps/storefront/src/app/(shop)/page.tsx` reads `x-storefront-type` and branches by strict equality:

- `'brand'` — existing flow: read `x-brand-slug`, call `getBrandContext(slug)`, render today's home. Byte-identical to today.
- `'tenant'` — render `<FoodHallStub storefrontName={...} />` using `x-storefront-name`.
- Anything else (missing, empty, unexpected) — `notFound()`.

## UI Sketch

```
Brand host (pizza-express.deliverse.app/)
  ┌──────────────────────────┐
  │ Pizza Express            │   ← unchanged from today
  │ Welcome. Sign in to ...  │
  └──────────────────────────┘

Tenant host (oomi-kitchen.deliverse.app/)
  ┌──────────────────────────┐
  │ OOMI Kitchen             │
  │ Food hall — coming soon. │   ← stub (DEL-25 replaces)
  │ Brand directory and ...  │
  └──────────────────────────┘
```

## Edge Cases

1. **Reserved subdomain (`www`, `admin`, `api`, `app`)** — `extractStorefrontSlug` returns `null`. Proxy short-circuits with stripped headers (same as today). Page renders `notFound()` (no `x-storefront-type` to branch on).
2. **Unknown slug (`nonexistent.localhost:3001`)** — `extractStorefrontSlug` returns slug; `resolveStorefrontBySlug` returns `null`. Proxy passes through with stripped headers. Page `notFound()` → 404.
3. **Soft-deleted storefront (`deleted_at IS NOT NULL`)** — same as unknown slug: resolver returns `null`, page 404s.
4. **Inactive storefront (`is_active=false`)** — same as unknown slug. (Mirrors `resolveBrandBySlug` semantics.)
5. **Inactive tenant (`tenants.status != 'active'`)** — same as unknown slug. (Mirrors `resolveBrandBySlug` semantics.)
6. **Client-supplied header spoofing** — proxy deletes `x-storefront-id`, `x-storefront-type`, `x-storefront-name`, `x-brand-slug` from the cloned request headers on every path. Client cannot drive the page into a different branch by sending fake headers.
7. **Schema-tolerant `baseDomain`** — `normalizeDomain` strips `<scheme>://`, port, trailing slash before comparison. Mirrors `extractBrandSlug`.
8. **`/` on root domain (no subdomain)** — `extractStorefrontSlug` returns `null`. Proxy returns a dev-helpful message at `/` (preserves today's behavior at [proxy.ts:43-46](../../apps/storefront/src/proxy.ts)).
9. **Edge runtime regression** — Next.js 16 proxy defaults to Node.js runtime. If a future maintainer adds `export const runtime = 'edge'` to the proxy, `@rp/db`'s `postgres` import will crash. No explicit `runtime = 'nodejs'` export needed today, but flag in code review.

## Intentional Deviation — `/api` bypass preserved

The proxy short-circuits on `pathname.startsWith('/api')` at [proxy.ts:33-35](../../apps/storefront/src/proxy.ts). AC#4 says "proxy injects `x-storefront-id` on every request" — DEL-20 deliberately interprets this scope as the page-handling path (non-`/api`):

- Better-Auth's tenant resolver in [storefront-tenant-context.ts:34-58](../../apps/storefront/src/lib/storefront-tenant-context.ts) reads `host` directly via `next/headers`, not proxy-injected headers. BA doesn't trust client-supplied storefront/brand headers, period — that's the security guarantee, regardless of whether the proxy could rewrite headers for the BA route handler.
- DEL-22 + DEL-23 will revisit the BA path when BA goes brand-optional.

The proxy still **strips** `x-storefront-*` and `x-brand-slug` on the `/api` path (defense-in-depth on the cloned headers), even though BA wouldn't read them.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Brand-host regression — M1 e2e fails on storefront subdomains | Low | High | Brand branch in proxy + page is structurally identical to today; full storefront + platform e2e suite is the gate before merge |
| Header spoofing reaches downstream (client drives page into tenant branch) | Low | High | Strip-before-branch on every request path (reserved, unknown, `/api`, resolved). E2E test 6 (unknown-host header-spoof → 404) is the explicit proof |
| Proxy DB call latency on every storefront request | Medium | Low | Single-table indexed query on `storefronts_slug_idx`; LRU cache as follow-up if needed |
| Proxy edge-runtime regression — `@rp/db` import crashes at edge | Low | Medium | Next.js 16 proxy defaults to Node.js runtime per docs; e2e proves end-to-end (DB import would crash at edge). Flag any future `runtime = 'edge'` change in review |
| `vi.mock('@rp/db', ...)` setup forgotten → CI fails on module load | Medium | Medium | Mirror `storefront-adapter.test.ts` mock pattern; run plain `pnpm test` (no Doppler) locally before pushing |
| E2E fixture leak — OOMI Kitchen Test rows linger after test failure | Low | Low | `afterAll` deletes; slug suffix `-test` quarantines from any real OOMI Kitchen later seeded via DEL-25 |

## Open Questions

None blocking. All deferred questions resolved in the Decisions Log below.

## Decisions Log

| Date | Decision | Reasoning |
|---|---|---|
| 2026-05-27 | `extractStorefrontSlug` returns plain string (matches `extractBrandSlug`), not an object | Symmetry keeps DEL-22's eventual import-rename swap mechanical; type info comes from the resolver, not the extractor |
| 2026-05-27 | New file `storefront-resolver.ts`, not extending `storefront-tenant-resolver.ts` | Different return shape (`StorefrontContext` vs `BrandContext`), different consumers; keeping resolvers separate makes DEL-22's eventual swap cleaner |
| 2026-05-27 | Subpath export `@rp/auth-core/storefront-resolver`; no root `index.ts` re-export | Mirrors existing pattern in `@rp/auth-core/storefront-host`, `@rp/auth-core/storefront-tenant-resolver` |
| 2026-05-27 | Map `primaryBrandId: null` → `brandId: undefined` (not `brandId: null`) in `StorefrontContext` | Optional property contract is honest — TypeScript's `brandId?: string` shouldn't carry a `null` payload |
| 2026-05-27 | Proxy injects `x-storefront-type` and `x-storefront-name`, not only `x-storefront-id` | Avoids a second DB call on the page side for the tenant stub; AC#4 names `x-storefront-id` but doesn't forbid additional headers |
| 2026-05-27 | Page reads `x-storefront-type` and branches by **strict equality** on `'brand'` / `'tenant'` | Defensive — anything else (missing, empty, future enum) `notFound()`s rather than falling through to the brand branch |
| 2026-05-27 | Strip `x-storefront-*` and `x-brand-slug` on EVERY proxy path (reserved, unknown, `/api`, resolved) | Defense-in-depth; the proxy is the only writer. Near-zero cost; closes the spoof window in fall-through paths |
| 2026-05-27 | `/api` bypass preserved as-is | BA resolves tenant via `host` directly; DEL-22 will revisit when BA goes brand-optional. Documented as Intentional Deviation above |
| 2026-05-27 | OOMI Kitchen Test fixture lives in the e2e spec's `beforeAll` / `afterAll`, NOT in `seed.ts` | Canonical seed runs against stg/prd on operator demand — adding a fixture there would silently change those environments. Slug suffix `-test` avoids future collision |
| 2026-05-27 | Tenant-host stub is a minimal server component with no food-hall-specific code | Keeps DEL-25's diff focused on UX. The stub asserts the routing path works; full shell is a separate concern |
| 2026-05-27 | Mark `extractBrandSlug` `@deprecated` with JSDoc pointing at DEL-22; do not delete | BA still uses `extractBrandSlug` via the adapter wrapper. Deletion is DEL-22's call when the brand-optional refactor lands |
| 2026-05-27 | Proxy DB call accepted; LRU cache deferred | Single-table indexed lookup is ~1ms; defer optimization until evidence shows it's needed |

---

## Files that will change

- `docs/specs/storefront-host-resolution.md` — this file.
- `packages/auth-core/src/storefront-host.ts` — `+ extractStorefrontSlug`, mark `extractBrandSlug` `@deprecated`.
- `packages/auth-core/src/storefront-resolver.ts` (new) — `resolveStorefrontBySlug` + `StorefrontContext` type.
- `packages/auth-core/package.json` — `+ "./storefront-resolver"` subpath export.
- `packages/auth-core/__tests__/storefront-host.test.ts` (extend or create) — pure-function tests for `extractStorefrontSlug`.
- `packages/auth-core/__tests__/storefront-resolver.test.ts` (new) — narrow row-mapping tests with `vi.mock('@rp/db', ...)`.
- `apps/storefront/src/lib/tenant-resolution.ts` — `+ extractStorefrontSlug` env-wrapper next to existing `extractBrandSlug` wrapper.
- `apps/storefront/src/proxy.ts` — async; strip-before-branch; call new extractor + resolver; new header injection; preserve `/api` bypass.
- `apps/storefront/src/app/(shop)/page.tsx` — strict-equality branch on `x-storefront-type`.
- `apps/storefront/src/components/food-hall-stub.tsx` (new) — minimal server component for `type='tenant'` home.
- `apps/storefront/tests/e2e/storefront-host-resolution.spec.ts` (new) — 6 cases with self-managed tenant fixture (`beforeAll` / `afterAll`).

**Explicitly NOT modified:**

- `packages/db/src/seed.ts` — canonical seed stays clean; e2e spec owns its tenant fixture.
