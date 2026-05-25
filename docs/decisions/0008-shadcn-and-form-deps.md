# 0008 — shadcn primitives + React Hook Form transitive deps

**Date:** 2026-05-25
**Status:** Accepted
**Deciders:** Vlad

## Context

[DEL-2](https://linear.app/oveglobal/issue/DEL-2) calls for installing the first batch of shadcn primitives in `packages/ui` and rewriting the three placeholder login/verify forms on a modern, accessible form pattern. Two dep-shaped questions need explicit sign-off per AGENTS.md "Never add a dependency without justification":

1. **shadcn `add`** introduces Radix peer deps + the `input-otp` library transitively into `packages/ui`. The exact set is determined by which primitives we install (this issue: `button`, `card`, `input`, `label`, `field`, `input-otp`).
2. **Form state + validation** isn't covered by existing deps. Better-Auth handles the *call*; we need a client-side layer for per-field validation, `aria-invalid` wiring, and submit lifecycle. shadcn's current React Hook Form guide (and the generated `field.tsx`) point at `useForm` + `Controller` + `<Field>` / `<FieldError>` composition with `zodResolver`.

The spec [`docs/specs/ui-foundations.md`](../specs/ui-foundations.md) §9 names this ADR as the authoritative dep list, written *after* the CLI runs so it reflects truth rather than a guess.

## Decision

Add the following deps. Versions are the pnpm resolution at install time; declared as `^` ranges per workspace convention.

### `packages/ui` (added by `pnpm dlx shadcn@latest add button card input label field input-otp`)

| Package | Version | Why |
|---|---|---|
| `@radix-ui/react-label` | `^2.1.8` | Accessible `<Label>` primitive that the `label` and `field` shadcn components compose. |
| `@radix-ui/react-separator` | `^1.1.8` | Brought in by `field` (which uses a `separator` internally — also generates `src/components/separator.tsx`). |
| `@radix-ui/react-slot` | `^1.2.4` | Polymorphic `asChild` substrate used across `button`, `card`, and others. |
| `input-otp` | `^1.4.2` | The vendored OTP-input library shadcn wraps in `input-otp.tsx`. Small, focused, no other transitive deps of concern. |

(Already present in `packages/ui` from earlier work — listed for completeness: `class-variance-authority`, `clsx`, `tailwind-merge`, `lucide-react`, `react`.)

### `apps/platform` and `apps/storefront` (added by `pnpm --filter @rp/{platform,storefront} add react-hook-form @hookform/resolvers zod`)

| Package | Version | Why |
|---|---|---|
| `react-hook-form` | `^7.76.1` | Form state + per-field validation. Used by all three login/verify forms; future signup forms ([DEL-7](https://linear.app/oveglobal/issue/DEL-7)) reuse the same pattern. |
| `@hookform/resolvers` | `^5.4.0` | Zod ↔ RHF bridge (`zodResolver`). |
| `zod` | `^3.25.76` | Schema declaration. Declared explicitly in each consuming app even though already present transitively via `@rp/auth-core` — the forms `import { z } from 'zod'` directly. |

### Side file

`pnpm dlx shadcn@latest add field` also generated `src/components/separator.tsx` (because `field` composes a separator). Kept; harmless even though no DEL-2 form uses it directly.

## Alternatives Considered

- **Older `components/ui/form.tsx` wrapper pattern** (the `<Form>` + `useFormContext` shape from earlier shadcn docs). Rejected: not the current docs' preferred Field-based RHF pattern. Adopting it would anchor the codebase to vocabulary that's no longer where shadcn's docs point. The modern guide ([shadcn React Hook Form](https://ui.shadcn.com/docs/forms/react-hook-form), [Field component](https://ui.shadcn.com/docs/components/field)) directs callers to `useForm` + `Controller` + `<Field>` directly.
- **Mantine / Chakra.** Different design system; conflicts with the shadcn / Tailwind / CSS-vars stack already in `packages/ui` (`globals.css`, `components.json`, `cn()`).
- **Formik.** Heavier than RHF; less momentum in current React form ecosystem.
- **Plain `useState` for the three forms** (no RHF at all). Smaller diff but means hand-rolling per-field validation, `aria-invalid`, and submit-lifecycle plumbing — and re-doing it again for DEL-7's signup forms. Not worth saving the two deps.

## Consequences

### Positive

- Forms get per-field validation messages via `<FieldError errors={[fieldState.error]} />` and proper `aria-invalid` wiring — accessibility win.
- DEL-7 (signup) and any future server-action wrappers can share the same zod schemas (zod is already in auth-core's tree).
- `<InputOTP>` ships with the right ARIA semantics, auto-advance, and paste handling out of the box.
- shadcn's `add` keeps the codebase aligned with the current docs — future primitive installs follow the same flow.

### Negative

- Four new deps in `packages/ui` and three new deps in each app. The Radix peers are small, well-maintained, and required by shadcn's primitive substrate; RHF is ~9 KB gzipped. Net bundle impact is modest.
- Workspace-alias-vs-shadcn-CLI compatibility took one tsconfig tweak (added `baseUrl` + `paths: { "@rp/ui/*": ["./src/*"] }` to `packages/ui/tsconfig.json`) so the CLI could resolve the aliases declared in `components.json`. Future shadcn upgrades may revisit this — keep both in sync.

## Future implications

- New shadcn primitives go through the same CLI (`pnpm dlx shadcn@latest add <name>` inside `packages/ui`). Each install may add Radix transitive deps — diff and document in subsequent ADRs only if the dep is large / novel.
- A `paths` mapping is now part of `packages/ui/tsconfig.json`. If we ever move the source root or rename `@rp/ui`, both `components.json` aliases and `tsconfig.json` paths need updating.
- `field.tsx` is the source of truth for the modern shadcn form vocabulary. If shadcn upgrades change the `FieldError` props shape (e.g. away from `errors={[...]}`), the spec's canonical code block in [`ui-foundations.md` §6](../specs/ui-foundations.md#6-form-pattern-canonical) must be re-checked.

## References

- [DEL-2 issue](https://linear.app/oveglobal/issue/DEL-2)
- [docs/specs/ui-foundations.md](../specs/ui-foundations.md) — implementation spec
- [shadcn Forms guide](https://ui.shadcn.com/docs/forms)
- [shadcn React Hook Form guide](https://ui.shadcn.com/docs/forms/react-hook-form)
- [shadcn Field component](https://ui.shadcn.com/docs/components/field)
- [react-hook-form docs](https://react-hook-form.com/)
- [@hookform/resolvers / zodResolver](https://github.com/react-hook-form/resolvers)
