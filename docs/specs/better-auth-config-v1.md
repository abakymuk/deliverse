# Better-Auth config v1 — field mappings, plugins, OTP storage

**Status:** Accepted
**Date:** 2026-05-25
**Owner:** Vlad
**Issue:** [DEL-11](https://linear.app/oveglobal/issue/DEL-11/better-auth-config-v1-field-mappings-plugins-otp-storage)
**Blocked by:** [DEL-10](https://linear.app/oveglobal/issue/DEL-10) (schema)
**Builds on:** [`schema-v1-ba-compat.md`](./schema-v1-ba-compat.md) §6 (field audit), [`0007-ba-mapping-strategy.md`](../decisions/0007-ba-mapping-strategy.md) (mapping direction)

---

## 1. Goal

Wire both Better-Auth instances (`packages/auth-core/src/{platform,storefront}.ts`) at `better-auth@1.6.11` against the locked DEL-10 schema so that:

- every required BA model.field has an explicit `fields:` mapping in **Drizzle-property-key** form (per ADR 0007 §3.1),
- custom domain columns (`tenantId`, `currentBrandId`, `verification.type`, …) round-trip via `additionalFields`,
- the storefront's `emailOTP` plugin stores **hashed** OTP values (auth-spec §12),
- the storefront accepts every brand subdomain dynamically (no hardcoded `baseURL`),
- the organization plugin (platform) carries our four custom roles (`owner | manager | staff | viewer`) and a v1 permission matrix,
- writes that depend on tenant scoping fail with a **typed `BetterAuthError`**, not a raw `PostgresError`.

Lock this config before [DEL-1](https://linear.app/oveglobal/issue/DEL-1) (seed) and [DEL-3](https://linear.app/oveglobal/issue/DEL-3) (tenant injection).

## 2. Source of truth

- **Field audit:** [`schema-v1-ba-compat.md` §6](./schema-v1-ba-compat.md#6-ba-field-audit) — every 🅿️ row becomes a `fields:` entry verbatim; every ➕ row becomes an `additionalFields:` entry.
- **Mapping direction:** [ADR 0007](../decisions/0007-ba-mapping-strategy.md). The single biggest footgun: `fields:` values are **Drizzle property keys** (camelCase, as declared in `schema.ts`), not SQL column names. Misuse throws `BetterAuthError: The field "X" does not exist in the schema for the model "Y"` at runtime.
- **BA behavior:** read from the installed source under `node_modules/.pnpm/better-auth@1.6.11.../better-auth/dist/`, **not docs**. All decisions in §5 cite file:line.

## 3. Scope framing — DEL-11 is guard-only

DEL-11 ships **configuration only**: exhaustive mappings, custom roles, hashed OTP, hardened `trustedOrigins`, and `databaseHooks` that **throw** when required tenant-scoped columns are missing. The hooks do **not** inject. As a direct consequence:

> Every storefront write path that needs `tenantId` / `currentBrandId` / `verification.type` (signup, OTP send, OAuth callback, etc.) **fails loudly with a typed error in DEL-11.**

That is by design. The storefront BA instance is already documented as unsafe to expose until DEL-3 ([`schema-v1-ba-compat.md` §4](./schema-v1-ba-compat.md#4-constraints-carried-forward)).

**DEL-3's scope is broader than "swap hook bodies."** Because `input: false` blocks hook-side injection (§4 below), DEL-3 must change the injection strategy — most likely one of:

- drop `input: false` on the tenant-scoped fields and strip client-supplied values at the storefront route-handler / server-action boundary, or
- wrap the adapter below BA's input transforms, or
- introduce custom endpoints that supply `tenantId` before delegating to BA's internals.

DEL-11's hooks are documented *checkpoints*, not infrastructure DEL-3 builds directly on top of. DEL-3 may remove them entirely.

## 4. Why hooks can throw but not inject (two-pass input parser)

BA 1.6.11 runs **two** input transforms around a `databaseHooks.<model>.create.before` hook:

1. `parseUserInput` on the original request body before `createWithHooks` runs (`dist/api/routes/sign-up.mjs:162`, `dist/db/internal-adapter.mjs:58`).
2. A **second** input transform inside `getCurrentAdapter(adapter).create({ data: actualData })` after the hook merges its result (`dist/db/with-hooks.mjs:18` merges hook output into `actualData`; `dist/db/factory.mjs:429` re-runs `parseInputData`; `dist/db/schema.mjs:47` rejects any truthy `input: false` field).

Both passes enforce `input: false`. A hook that returns `{ data: { tenantId: 'foo' } }` for a field declared `input: false` gets that field rejected at pass 2 with `BAD_REQUEST: tenantId is not allowed to be set`.

`required: false` only silences pass 1's missing-field check (`dist/db/schema.mjs:78`); it does **not** bypass pass 2's input-not-allowed check.

The viable v1 shape:

| Field config | Effect |
|---|---|
| `input: false` | External callers cannot set the field (defense in depth — preserves tenant scope integrity). |
| `required: false` | Pass 1 does not throw on a missing field, so the request reaches the hook. |
| Hook (`create.before`) | If the field is absent, throws `BetterAuthError`. Never injects (would be rejected at pass 2). |
| DB `NOT NULL` (DEL-10) | Real enforcement layer. Catches anything the hook misses. |

## 5. Decisions (BA 1.6.11 source-verified)

| # | AC | Decision | BA source |
|---|---|---|---|
| 1 | AC#6 (OTP) | `emailOTP({ storeOTP: 'hashed' })` — native hashing, default hasher, verify path hashes input then constant-time-compares. | `dist/plugins/email-otp/otp-token.mjs:11-23`, `dist/plugins/email-otp/types.d.mts:59-64` |
| 2 | AC#7 (baseURL) | `trustedOrigins` as async function returning one explicit origin after subdomain-boundary validation; `baseURL` left unset on storefront. | `dist/context/helpers.mjs:60-84`, `dist/auth/trusted-origins.mjs:13-26` |
| 3 | AC#4 (write-path) | Storefront `additionalFields` declared `input: false, required: false`. `databaseHooks.{user,session,verification}.create.before` **throws** typed `BetterAuthError` on missing required field; does **not** inject. DEL-3 changes the injection strategy. | `dist/db/schema.mjs:40,47,78`, `dist/db/with-hooks.mjs:18`, `dist/db/factory.mjs:429` |
| 4 | AC#5 (roles) | `createAccessControl(defaultStatements)` + four `ac.newRole(...)`; pass `{ ac, roles: { owner, manager, staff, viewer }, creatorRole: 'owner' }` into `organization()`. Static AC only — `dynamicAccessControl` deliberately off per [`schema-v1-ba-compat.md` §6.3](./schema-v1-ba-compat.md#63-plugins-not-wired-in-v1). | `dist/plugins/access/access.d.mts:12-14`, `dist/plugins/organization/types.d.mts:243-279` |
| 5 | metadata | No action. Org plugin detects `typeof === 'string'` on read and `JSON.parse`s; Drizzle pg adapter passes objects to `jsonb` directly. | `dist/plugins/organization/routes/crud-org.mjs:146` |

## 6. Constraints carried forward

- **No new dependencies.** Everything below is BA built-in surface + stdlib (`crypto` is BA-internal — we don't import it).
- **Cookies scoped to exact subdomain.** `crossSubDomainCookies.enabled: false` on both instances. No wildcard. Preserves the gotcha from AGENTS.md.
- **Storefront BA unsafe to expose until DEL-3** ([`schema-v1-ba-compat.md` §4](./schema-v1-ba-compat.md#4-constraints-carried-forward)). Every signup/OTP/OAuth-callback path on storefront throws in DEL-11.
- **Soft-delete via `deletedAt`** — kept as `additionalFields.deletedAt: { type: 'date', required: false, input: false }` on both `user` models.
- **BA pinned at 1.6.11.** No version bump in this issue.

## 7. Platform instance — `packages/auth-core/src/platform.ts`

### 7.1 `database` (unchanged top-level map)

Already maps `user → platformUsers`, `account → platformAccounts`, `session → platformSessions`, `verification → platformVerifications`, `organization → tenants`, `member → tenantMemberships`, `invitation → tenantInvitations`. Leave as-is.

### 7.2 `user`

```ts
user: {
  fields: {
    emailVerified: 'emailVerified',  // diff #1 from DEL-10 — boolean, same Drizzle key
    image: 'imageUrl',                // fix existing 'image_url' bug — must be Drizzle key, not SQL col
  },
  additionalFields: {
    deletedAt: { type: 'date', required: false, input: false },
  },
},
```

All other BA `user` fields (`name`, `email`, `createdAt`, `updatedAt`) are ✅ same-key — omitted from `fields:` (BA falls back to its default name, which matches our Drizzle property).

### 7.3 `account` (NEW)

```ts
account: {
  fields: {
    userId: 'platformUserId',
  },
},
```

All other account fields (`accountId`, `providerId`, `password`, OAuth token columns, timestamps) are ✅ same-key.

### 7.4 `session` (NEW)

```ts
session: {
  fields: {
    userId: 'platformUserId',
  },
},
```

`activeOrganizationId` (DEL-10 diff #5) is same-key — the organization plugin reads/writes it via its default name, no `fields:` entry needed.

### 7.5 `verification`

No entries. All five core fields (`identifier`, `value`, `expiresAt`, `createdAt`, `updatedAt`) are ✅ same-key. No `additionalFields` on platform.

### 7.6 `organization` plugin — custom roles + schema

```ts
import { createAccessControl } from 'better-auth/plugins/access';
import { defaultStatements } from 'better-auth/plugins/organization/access';

const ac = createAccessControl(defaultStatements);

const owner = ac.newRole({
  organization: ['update', 'delete'],
  member: ['create', 'update', 'delete'],
  invitation: ['create', 'cancel'],
});

const manager = ac.newRole({
  organization: ['update'],
  member: ['create', 'update', 'delete'],
  invitation: ['create', 'cancel'],
});

const staff = ac.newRole({});   // read-only — no mutation grants
const viewer = ac.newRole({});  // read-only — no mutation grants

// ...

plugins: [
  organization({
    ac,
    roles: { owner, manager, staff, viewer },
    creatorRole: 'owner',
    allowUserToCreateOrganization: false,
    organizationLimit: 10,
    membershipLimit: 100,
    schema: {
      member: {
        fields: {
          organizationId: 'tenantId',
          userId: 'platformUserId',
        },
      },
      invitation: {
        fields: {
          organizationId: 'tenantId',
        },
      },
    },
  }),
],
```

`role`, `email`, `status`, `expiresAt`, `createdAt` on member/invitation are ✅ same-key. `inviterId` is ✅ same-key.

**Role permission matrix (v1 — sensible defaults, refine later):**

| Permission | owner | manager | staff | viewer |
|---|---|---|---|---|
| `organization:update` | ✓ | ✓ | – | – |
| `organization:delete` | ✓ | – | – | – |
| `member:create` (invite) | ✓ | ✓ | – | – |
| `member:update` | ✓ | ✓ | – | – |
| `member:delete` | ✓ | ✓ | – | – |
| `invitation:cancel` | ✓ | ✓ | – | – |
| read `organization` / `member` / `invitation` | ✓ | ✓ | ✓ | ✓ |

`team:*` unused in v1. Read permissions follow the org plugin's defaults — every member of an organization can read its members and invitations.

### 7.7 No `databaseHooks` on platform

Platform's custom NOT NULL columns (`name`, `email`, `emailVerified`, etc.) are all set by BA's normal create flow. No write-path guard needed.

### 7.8 Unchanged

`emailAndPassword` (min 12 chars, autoSignIn:false, sendResetPassword stub), `emailVerification` (sendOnSignUp:true, sendVerificationEmail stub), `socialProviders.google`, `session` timing (30d expires, 7d updateAge, 5min cookieCache), `advanced` (cookies — `cookiePrefix: 'rp_platform'`, `crossSubDomainCookies: false`, `sameSite: 'lax'`, `secure` from `NODE_ENV`).

## 8. Storefront instance — `packages/auth-core/src/storefront.ts`

### 8.1 `database` (unchanged top-level map)

Maps `user → tenantEndUsers`, `account → tenantEndUserAccounts`, `session → tenantEndUserSessions`, `verification → tenantEndUserVerifications`. Leave as-is. No org plugin → no `organization`/`member`/`invitation` mapping.

### 8.2 `user`

```ts
user: {
  fields: {
    emailVerified: 'emailVerified',  // diff #2 — boolean, same Drizzle key
    image: 'imageUrl',                // fix existing 'image_url' bug
  },
  additionalFields: {
    tenantId:  { type: 'string', required: false, input: false },  // round-trips; hook guards; DB NOT NULL enforces
    phone:     { type: 'string', required: false },
    deletedAt: { type: 'date',   required: false, input: false },
  },
},
```

### 8.3 `account` (NEW)

```ts
account: {
  fields: {
    userId: 'tenantEndUserId',
  },
},
```

`password` retained (hybrid auth) — same-key, no `fields:` entry.

### 8.4 `session` (NEW)

```ts
session: {
  fields: {
    userId: 'tenantEndUserId',
  },
  additionalFields: {
    currentBrandId: { type: 'string', required: false, input: false },
  },
},
```

### 8.5 `verification` (NEW)

```ts
verification: {
  additionalFields: {
    tenantId: { type: 'string', required: false, input: false },
    brandId:  { type: 'string', required: false, input: false },
    type:     { type: 'string', required: false, input: false },  // backs the verification_type enum
    attempts: { type: 'number', required: false, input: false, defaultValue: 0 },  // wired by DEL-9
  },
},
```

### 8.6 `emailOTP` plugin (hashed)

```ts
plugins: [
  emailOTP({
    storeOTP: 'hashed',     // ← new; stores SHA-256 hash of OTP, verify path hashes + constant-time-compares
    otpLength: 6,
    expiresIn: 60 * 10,
    disableSignUp: false,
    sendVerificationOTP: async ({ email, otp, type }) => {
      // DEV stub — DEL-5 wires Resend
      console.log(`[DEV] OTP for ${email} (${type}): ${otp}`);
    },
  }),
],
```

The persisted `value` becomes `${hash}:${attempts}` (e.g. `<64-hex>:0`) per `dist/plugins/email-otp/otp-token.mjs`. The bare hash without the attempts suffix is **not** what to assert on in future smoke tests.

### 8.7 Dynamic origin — `trustedOrigins`

Picked over per-request `baseURL` because BA 1.6.11 natively supports an async function returning per-request origin lists (`dist/context/helpers.mjs:60-84`); no route-handler wrapping needed. `baseURL` stays unset — BA falls back to validating each request via `trustedOrigins` and to deriving cookie domain from the request host.

The origin-validation logic is extracted into a small **pure exported helper** so it can be unit-asserted without a running server.

```ts
/**
 * Pure helper: does `host` belong to the configured storefront base domain?
 *
 * Normalizes case + strips port from both sides before comparing so
 * `pizza-express.localhost:3001` and `PIZZA-EXPRESS.localhost` both compare
 * cleanly against `localhost`.
 *
 * The leading `.` in the suffix check prevents `evildeliverse.app` from
 * matching `deliverse.app` (which a naive `endsWith` would allow).
 */
export function isAllowedStorefrontOrigin(
  host: string | null | undefined,
  baseDomain: string | undefined,
): boolean {
  if (!host || !baseDomain) return false;
  const normalize = (s: string) => s.toLowerCase().split(':')[0];
  const h = normalize(host);
  const b = normalize(baseDomain);
  if (!h || !b) return false;
  return h === b || h.endsWith('.' + b);
}

// ...

const storefrontAuth = betterAuth({
  // baseURL intentionally unset — see spec §8.7
  // ...
  trustedOrigins: async (request) => {
    if (!request) return [];
    const host = request.headers.get('host');
    const baseDomain = process.env.NEXT_PUBLIC_STOREFRONT_BASE_DOMAIN;
    if (!isAllowedStorefrontOrigin(host, baseDomain)) return [];
    const proto = process.env.NODE_ENV === 'production' ? 'https' : 'http';
    // Return lowercase host with port preserved — matches the browser's
    // Origin header exactly (BA uses wildcardMatch, which reduces to exact
    // string equality on a pattern with no '*').
    return [`${proto}://${host!.toLowerCase()}`];
  },
});
```

Env shape:

| Env | `NEXT_PUBLIC_STOREFRONT_BASE_DOMAIN` |
|---|---|
| dev | `localhost` (port is part of the request host but stripped before comparison) |
| stg | `staging.deliverse.app` |
| prd | `deliverse.app` |

### 8.8 `databaseHooks` (throw-only)

```ts
import { BetterAuthError } from 'better-auth';

// ...

databaseHooks: {
  user: {
    create: {
      before: async (user) => {
        if (!user.tenantId) {
          throw new BetterAuthError(
            'tenant_id missing on storefront user create (DEL-11 stub; DEL-3 wires the real injection path)',
          );
        }
      },
    },
  },
  session: {
    create: {
      before: async (session) => {
        if (!session.currentBrandId) {
          throw new BetterAuthError(
            'current_brand_id missing on storefront session create (DEL-11 stub; DEL-3 wires the real injection path)',
          );
        }
      },
    },
  },
  verification: {
    create: {
      before: async (verification) => {
        if (!verification.tenantId) {
          throw new BetterAuthError(
            'tenant_id missing on storefront verification create (DEL-11 stub; DEL-3 wires the real injection path)',
          );
        }
        if (!verification.type) {
          throw new BetterAuthError(
            'verification.type missing (must be one of otp_login | email_verify | password_reset) — DEL-11 stub; DEL-3 wires the real injection path',
          );
        }
      },
    },
  },
},
```

These hooks **never** inject — see §4. They fire identically for BA-default create paths and for plugin-driven creates (e.g. `emailOTP` internal `createVerificationValue`).

### 8.9 Unchanged

`emailAndPassword` (min 8 chars, autoSignIn:true, hybrid with OTP, sendResetPassword stub), `socialProviders.google`, `session` timing (30d/7d/5min), `advanced` (cookies — `cookiePrefix: 'rp_store'`, `crossSubDomainCookies: false`, `sameSite: 'lax'`, `secure` from `NODE_ENV`).

## 9. Write-path contract (AC#4)

Every required tenant-scoped column on the storefront, and the create path that touches it in DEL-11:

| Column (DB) | additionalField config | Hook that guards it | BA create paths that hit this hook |
|---|---|---|---|
| `tenant_end_users.tenant_id` | `tenantId: { input:false, required:false }` | `databaseHooks.user.create.before` | `/sign-up/email`, OAuth callback (Google), emailOTP first-sign-up |
| `tenant_end_user_sessions.current_brand_id` | `currentBrandId: { input:false, required:false }` | `databaseHooks.session.create.before` | every successful sign-in (email/password, OAuth, OTP) |
| `tenant_end_user_verifications.tenant_id` | `tenantId: { input:false, required:false }` | `databaseHooks.verification.create.before` | `emailOTP.sendVerificationOTP` (internal `createVerificationValue`), email-verification flow, password-reset flow |
| `tenant_end_user_verifications.type` | `type: { input:false, required:false }` | same | same |

DEL-3 will need to supply these fields from a request-scoped tenant resolver. The exact mechanism (drop `input:false` + boundary filter, wrapped adapter, or custom endpoints) is DEL-3's design call — this spec doesn't pre-commit.

## 10. Out of scope

- Real `tenantId` injection — [DEL-3](https://linear.app/oveglobal/issue/DEL-3).
- Real Resend email delivery — [DEL-4](https://linear.app/oveglobal/issue/DEL-4) / [DEL-5](https://linear.app/oveglobal/issue/DEL-5) / [DEL-6](https://linear.app/oveglobal/issue/DEL-6).
- OTP rate-limit wiring (the `attempts` field exists; consumer is [DEL-9](https://linear.app/oveglobal/issue/DEL-9)).
- Postgres RLS — auth-spec §12, deferred.
- Account linking (Google ↔ password) — BA defaults handle it.
- BA version bump — no.
- New dependencies — no.
- **Live OTP storage DB smoke test** — DEL-11 cannot exercise this; the verification create hook throws before BA can write a verification row. Moved to DEL-3 / DEL-5.

## 11. Verification checklist

- [ ] `pnpm typecheck` clean across the workspace (no env required).
- [ ] `doppler run -- pnpm dev` boots both apps with zero BA startup validation errors. *(Best-effort — needs Doppler `dev` config.)*
- [ ] `curl http://localhost:3000/api/auth/get-session` → `{}` (empty session). *(Best-effort.)*
- [ ] `curl -H 'Host: pizza-express.localhost:3001' http://localhost:3001/api/auth/get-session` → `{}`. Auth route boots and resolves an empty session for a tenant-style host. This does **not** by itself exercise `trustedOrigins` — `get-session` is a GET with no `Origin` header, so the origin middleware is not triggered. *(Best-effort.)*
- [ ] **Origin boundary check — unit-style, not curl.** A short `tsx` scratch script (e.g. `packages/auth-core/scratch/origin-check.ts`) imports `isAllowedStorefrontOrigin` and asserts:
  - `isAllowedStorefrontOrigin('pizza-express.deliverse.app', 'deliverse.app') === true`
  - `isAllowedStorefrontOrigin('deliverse.app', 'deliverse.app') === true`
  - `isAllowedStorefrontOrigin('evildeliverse.app', 'deliverse.app') === false`
  - `isAllowedStorefrontOrigin('pizza-express.localhost:3001', 'localhost') === true`
  - `isAllowedStorefrontOrigin('PIZZA.LOCALHOST', 'localhost') === true`
  - `isAllowedStorefrontOrigin(null, 'deliverse.app') === false`
  - `isAllowedStorefrontOrigin('x.deliverse.app', undefined) === false`

  `@rp/auth-core` does not currently have Vitest wired (no `vitest.config.ts` in the package). Prefer the scratch script over standing up the test runner in this issue.
- [ ] Mock storefront user create via `storefrontAuth.api.signUpEmail({ ... })` in a scratch script — surfaces `BetterAuthError: tenant_id missing on storefront user create ...`, **not** a `PostgresError`. *(Best-effort.)*
- [ ] Mock storefront OTP send via the same path — surfaces `BetterAuthError: tenant_id missing on storefront verification create ...`. Confirms the hook fires for `emailOTP`'s internal `createVerificationValue` call. *(Best-effort.)*
- [ ] Create an organization via `platformAuth.api.createOrganization({ metadata: { theme: 'dark' } })`, read it back — `metadata` deserializes to the original object (jsonb round-trip per `dist/plugins/organization/routes/crud-org.mjs:146`). *(Best-effort.)*
- [ ] **Deferred to DEL-3 / DEL-5** (explicitly *not* DEL-11): trigger a real OTP send end-to-end and confirm `tenant_end_user_verifications.value` is shaped as `<hex-hash>:0` (BA stores `${hash}:${attempts}`). DEL-11 cannot exercise this because the verification create hook throws before BA can write.
