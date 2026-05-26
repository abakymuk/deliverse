# 0011 — `@rp/emails` install diff vs. ADR-0009 anticipated set

**Date:** 2026-05-26
**Status:** Accepted
**Deciders:** Vlad
**Builds on:** [ADR-0009](./0009-emails-package-shape.md), [`docs/specs/email-delivery.md`](../specs/email-delivery.md), [`docs/specs/otp-email.md`](../specs/otp-email.md)
**Pattern:** [ADR-0008](./0008-shadcn-and-form-deps.md) (write the ADR *after* the install diff, against actual resolved versions, not against guesses)

## Context

[DEL-4](https://linear.app/oveglobal/issue/DEL-4) closed the architecture for transactional email delivery and shipped an empty `packages/emails/` skeleton. [ADR-0009](./0009-emails-package-shape.md) §"Anticipated deps" listed the dep set we expected `pnpm install` to resolve in [DEL-5](https://linear.app/oveglobal/issue/DEL-5):

> `packages/emails/`: `inngest`, `resend`, `react-email` (v6 unified), `react`, `zod`, `@rp/db` (workspace).
> `apps/platform`: `inngest` (same version), for triggering events + hosting `/api/inngest`.
> `apps/storefront`: `inngest` (same version), for triggering events only.

[DEL-5](https://linear.app/oveglobal/issue/DEL-5)'s spec [`docs/specs/otp-email.md`](../specs/otp-email.md) §4 decision #2 *amended* this list to also include `@react-email/components` and `@react-email/render`, on the assumption that `react-email@6.0.0` shipped with a [documented packaging bug (issue #3414)](https://github.com/resend/react-email/issues/3414) where the scaffolded `import { ... } from 'react-email'` doesn't resolve and callers had to import from `@react-email/components` directly.

When `pnpm install` actually ran, two assumptions turned out to be wrong (one in ADR-0009, one in `docs/specs/otp-email.md`). This ADR records the actual install + the corrections.

## Decision — the actual install set

### `packages/emails/`

```jsonc
"dependencies": {
  "@react-email/render": "^2.0.8",   // peer of resend; resolved transitively, kept explicit for grep
  "@rp/db": "workspace:*",
  "inngest": "^4.4.0",               // not ^3.x — Inngest v4 is current stable
  "react": "^19.2.6",                // matches both apps' React 19 from Next 16 upgrade
  "react-dom": "^19.2.6",            // peer of react-email — see §"Surprises" #3 below
  "react-email": "^6.3.3",           // v6.3.3 IS unified — exports all components + render API
  "resend": "^6.12.4",               // not ^5.x — Resend SDK v6 is current
  "zod": "^4"                        // matches @rp/auth-core; resolves to 4.4.3
},
"devDependencies": {
  "@rp/typescript-config": "workspace:*",
  "@types/node": "^22.10.0",
  "@types/react": "^19.2.15",
  "@types/react-dom": "^19.2.3",
  "typescript": "^5.7.0",
  "vitest": "^2.1.0"                 // matches both apps' Vitest 2.x for the unit test
}
```

**No `@react-email/components`** — see Surprise #1.

### `apps/platform/`

```jsonc
"@rp/emails": "workspace:*",  // hosts /api/inngest, imports inngest + functions from @rp/emails/inngest
"inngest": "^4.4.0"           // for `serve` from 'inngest/next'
```

### `apps/storefront/`

**No change.** ADR-0009 anticipated `inngest` here — see Surprise #4.

### `packages/auth-core/`

```jsonc
"@rp/emails": "workspace:*"  // storefront factory imports the inngest client from @rp/emails/inngest
```

No direct `inngest` declaration — the symbol comes through the `@rp/emails/inngest` re-export.

## Surprises (the load-bearing part of this ADR)

### 1. `react-email@6.3.3` IS the unified package — the "split bug" prediction was wrong

[`docs/specs/otp-email.md`](../specs/otp-email.md) §4 decision #2 cited [react-email#3414](https://github.com/resend/react-email/issues/3414) and predicted templates would have to import from `@react-email/components` because `import { ... } from 'react-email'` wouldn't resolve.

**Actual install:** `react-email@6.3.3`'s `dist/index.mjs` exports every component (`Body`, `Button`, `Container`, `Head`, `Heading`, `Html`, `Img`, `Link`, `Preview`, `Section`, `Text`, `Tailwind`, etc.) AND `export * from "@react-email/render"`. The "v6 unified single package" framing from [ADR-0009 §Decision 2](./0009-emails-package-shape.md) was correct as of v6.3.3 — the linked GitHub issue is either fixed or never affected the imports we actually use.

**Consequence:** templates import from `'react-email'` directly. We dropped `@react-email/components` from the install (NPM marks it deprecated as of v1.0.12, presumably because v6 unified it).

```ts
// packages/emails/src/templates/otp.tsx
import { Body, Container, Head, Html, Img, Section, Text } from 'react-email';
```

### 2. `inngest` v4, `resend` v6, `@react-email/render` v2 — not the major versions we expected

ADR-0009 was version-agnostic. The plan's mental model leaned on `inngest@^3.x` (the version we saw in older Inngest docs) and `resend@^5.x`. Actual resolution:

- `inngest@4.4.0` (current stable; v4 introduced new step APIs but `inngest.createFunction` + `step.run` shapes used by the OTP handler are stable across v3→v4).
- `resend@6.12.4` (current stable; `resend.emails.send` API unchanged from v5).
- `@react-email/render@2.0.8` (peer-dep of `resend@6`; we keep it as an explicit top-level dep so grep finds it, even though it would arrive transitively).

Nothing in these majors broke our spec's API assumptions, but the version numbers in commit messages / PR descriptions need to reflect the actual majors.

### 3. `react-dom` is required — peer-dep of `react-email`

[`docs/specs/otp-email.md`](../specs/otp-email.md) §9 said "**Do not add `react-dom` unless the install diff or peer warnings require it** (`@react-email/render` ships its own SSR)". Install diff revealed `react-email@6.3.3` itself peer-deps `react-dom: "^18.0 || ^19.0 || ^19.0.0-rc"` (separate from `@react-email/render` which has its own SSR).

**Consequence:** `react-dom@^19.2.6` added to `packages/emails` runtime deps + `@types/react-dom@^19.2.3` to devDeps. Matches both apps' React 19 from the Next 16 upgrade.

### 4. `apps/storefront` does NOT get a direct `inngest` dep

[ADR-0009 §"Anticipated deps"](./0009-emails-package-shape.md#anticipated-deps-installed-by-del-5--del-6-not-del-4) said `apps/storefront: inngest (same version), for triggering events only`. Closer reading of the storefront's runtime tree:

- `apps/storefront`'s only `inngest.send(...)` call site is the OTP callback in [`packages/auth-core/src/storefront.ts`](../../packages/auth-core/src/storefront.ts) (the storefront factory).
- That callback imports `inngest` from `@rp/emails/inngest`, which is a `packages/auth-core` workspace dep, not an `apps/storefront` one.
- The storefront app itself imports nothing from `inngest`.

**Consequence:** `apps/storefront/package.json` is untouched in this issue. If a future storefront feature ever calls `inngest.send` directly (not through a callback closed over by `@rp/auth-core`), it can add the dep then.

### 5. Pre-existing unrelated peer-dep warning surfaces during install

`pnpm install` reports:

```
apps/platform
└─┬ better-call 1.3.5
  └── ✕ unmet peer zod@^4.0.0: found 3.25.76
```

This is a pre-existing mismatch between `better-call` (a Better-Auth transitive on `apps/platform`) and `apps/platform`'s pinned `zod@^3.25.76`. It is **not introduced** by DEL-5 (the warning also reproduces on `main` before this PR). Out of scope; flag in a future issue if BA upgrade requires resolving it.

### 6. ~30 deprecated subdeps from React Email's component tree

NPM marks `@react-email/components@1.0.12` deprecated, plus ~20 nested `@react-email/<component>@<old-version>` subdeps (`@react-email/body@0.3.0`, `@react-email/button@0.2.1`, etc.). They are pulled in transitively by `react-email@6.3.3` and `@react-email/render@2.0.8` and cannot be deduped — these are React Email's own legacy single-component packages that v6 superseded but still depend on internally. No runtime impact for our use; documented here so the install-time warning isn't a surprise on future re-installs.

## Alternatives Considered

- **Keep `@react-email/components` as the import source** (per the plan's original framing). Rejected after install diff confirmed `react-email@6.3.3` exports everything we need. Importing from the deprecated package would invite future churn when it stops resolving.
- **Pin `inngest@^3.x` for stability.** Rejected — v4 is current stable, the APIs we use (`createFunction` + `step.run`) are unchanged, and pinning to an older major guarantees a future upgrade ADR.
- **Skip `react-dom` and rely on `@react-email/render`'s own SSR.** Rejected — `react-email@6.3.3` peer-deps `react-dom` at the package level. Suppressing peer warnings is worse than declaring the dep.
- **Add `inngest` to `apps/storefront` per ADR-0009's original list.** Rejected — the dep would be unused; minimum-surface principle says don't declare what you don't import. Re-evaluate if a storefront feature ever sends events without going through `@rp/auth-core`.

## Consequences

### Positive

- Templates import from a single package (`react-email`) — matches the "boring tech" philosophy and ADR-0009's original framing.
- Three apps/packages touched (`@rp/emails`, `apps/platform`, `packages/auth-core`) instead of four — smaller surface, less to maintain.
- All resolved versions are current stables, so the next 6-12 months of dep upgrades should be patch/minor.

### Negative

- React Email v6's transitive-dep tree still ships ~20 deprecated `@react-email/<component>` packages. We can't deduplicate them without forking React Email. Acceptable cost (build-time warning only, no runtime impact).
- `react-email` v6.3.3's peer-dep on `react-dom` adds a runtime dep that does nothing at email-render time (`@react-email/render` does its own SSR). Documenting here so the next maintainer doesn't try to remove it.

### Neutral

- `@react-email/render` is both a top-level dep (for explicit grep / future direct calls) AND a transitive of `react-email` + `resend`. pnpm dedupes the version, so no install-size penalty.

## Future implications

- **Inngest v5 upgrade** (whenever it lands) — single `pnpm up inngest` in `packages/emails` + `apps/platform`. The function registry in `apps/platform/src/app/api/inngest/route.ts` may need adjustment if `serve()` signature changes.
- **React Email v7** — if it actually splits the package again, this ADR's "v6.3.3 is unified" claim becomes a snapshot. Re-evaluate at upgrade time.
- **Better-Auth → zod v4 upgrade** — when BA's `better-call` dep starts requiring zod v4 unconditionally (today it's a peer-warning, not an error), `apps/platform` + `apps/storefront` will need to bump from zod v3. Track as a separate issue when it surfaces.

## References

- [`docs/specs/otp-email.md`](../specs/otp-email.md) — DEL-5 implementation spec (corrected in commit 5 to reflect this ADR's findings).
- [`docs/specs/email-delivery.md`](../specs/email-delivery.md) — DEL-4 architecture spec.
- [ADR-0009](./0009-emails-package-shape.md) — package shape + anticipated-deps (amended in commit 5 to reflect this ADR's findings).
- [ADR-0008](./0008-shadcn-and-form-deps.md) — same "write the ADR against the install diff" pattern this one inherits.
- [react-email#3414](https://github.com/resend/react-email/issues/3414) — the bug the plan feared; not reproduced at v6.3.3.
- Inngest [v4 changelog](https://www.inngest.com/docs/changelog).
- Resend [v6 changelog](https://resend.com/changelog).
