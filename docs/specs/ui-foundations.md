# UI foundations — shadcn primitives + React-Hook-Form login forms

**Status:** Accepted
**Date:** 2026-05-25
**Owner:** Vlad
**Issue:** [DEL-2](https://linear.app/oveglobal/issue/DEL-2/install-shadcn-primitives-in-packagesui-rewrite-both-login-forms-on)
**Builds on:** [`better-auth-config-v1.md`](./better-auth-config-v1.md) (preserves the BA wiring DEL-11 shipped), [`seed-data.md`](./seed-data.md) (uses the seeded admin + brand for smoke checks)

---

## 1. Goal

Close M0 — Local-dev unblock — by giving the workspace a real UI primitive set and rewriting the three placeholder login forms on the **modern shadcn React-Hook-Form + Field pattern**. After this lands:

- `packages/ui/src/components/` is no longer empty.
- `apps/platform/src/components/auth/login-form.tsx` and `apps/storefront/src/components/auth/{login-form,verify-otp-form}.tsx` no longer render raw `<input>`/`<button>` with inline Tailwind.
- Per-field validation messages surface as `<FieldError>` instead of a single bottom-of-form error string.
- The storefront OTP verify screen uses a real 6-segment OTP input.
- A new ADR documents every dep that landed.

## 2. Source of truth

- **Modern shadcn forms pattern**, NOT the legacy `components/ui/form.tsx` wrapper: [shadcn Forms](https://ui.shadcn.com/docs/forms), [React Hook Form guide](https://ui.shadcn.com/docs/forms/react-hook-form), [Field component](https://ui.shadcn.com/docs/components/field).
- **Linear DEL-2** for the dataset of components + AC.
- **Existing config** that DEL-2 *does not* re-create: [`packages/ui/components.json`](../../packages/ui/components.json) (shadcn config), [`packages/ui/src/styles/globals.css`](../../packages/ui/src/styles/globals.css) (CSS vars, light + dark `@theme` blocks), [`packages/ui/src/lib/utils.ts`](../../packages/ui/src/lib/utils.ts) (`cn()` helper). All in place from earlier work.

## 3. Scope framing

**In scope:** install six shadcn primitives in `packages/ui`, rewrite three forms in the apps, add one ADR.

**Out of scope** (§10): brand theming per tenant, signup forms (DEL-7), forgot-password / reset-password page UI, `alert` primitive, server actions wrapping BA APIs.

## 4. Decisions

| # | Decision | Source |
|---|---|---|
| 1 | **shadcn primitives to install:** `button`, `card`, `input`, `label`, `field`, `input-otp`. **`field`, not the legacy `form` wrapper.** Modern shadcn's RHF guide directs callers to use `Field` / `FieldLabel` / `FieldError` directly with RHF's `Controller`. | Sources cited in §2. |
| 2 | **Form pattern:** `useForm` from `react-hook-form` + `zodResolver` from `@hookform/resolvers/zod` + `<Controller>` per field + shadcn's `<Field>` / `<FieldLabel>` / `<FieldError>` composition + `aria-invalid` on inputs. One zod schema per form (or per mode for the storefront's OTP/password toggle). | User-confirmed. |
| 3 | **New deps**, added manually (RHF + resolvers + zod are not transitive of `field`): `pnpm --filter @rp/platform add react-hook-form @hookform/resolvers zod` and same for `@rp/storefront`. **Declare `zod` explicitly** even though it's in the lockfile via auth-core — the forms `import { z } from 'zod'` directly. | AGENTS.md "Never add a dep without justification". |
| 4 | **`Card` is the form wrapper.** Each `/login` page renders the form inside a centered `<Card>` with `<CardHeader>` (title + description) and `<CardContent>` (form fields + actions). | Matches shadcn login-block aesthetic. |
| 5 | **`InputOTP` on the storefront verify-OTP form.** Six-segment view, `inputMode='numeric'`, `autoComplete='one-time-code'`. Replaces the current single `<input maxLength={6}>`. | Linear AC #4. |
| 6 | **Preserve BA wiring verbatim.** `signIn.email`, `signIn.social({provider:'google',…})`, `emailOtp.sendVerificationOtp`, `signIn.emailOtp` call sites stay unchanged. Only surrounding markup + state management changes. | DEL-11 hotfix already verified end-to-end sign-in works. |
| 7 | **No theme customization per brand in v1.** Brand-themed Tailwind tokens (storefront pulling `brandingJson.primary` from `getBrandContext`) is Phase 4. Storefront login renders the seeded brand **name** only; colors stay default. | Linear non-goal. |
| 8 | **No `alert` primitive.** Errors surface as per-field `<FieldError>`; submit-level errors (e.g. 401) render as an inline `<p>` near the submit button. Add `alert` when something needs a banner. | Smaller diff. |
| 9 | **No Google brand icon.** Lucide doesn't ship an official Google icon and substituting `Mail` would mislead users. The Google OAuth button is **text-only** (`Continue with Google`) in v1. Inline SVG can be added later if visual recognizability matters. | User direction. |

## 5. Components to install

Run the shadcn CLI **inside `packages/ui/`** (it picks up `components.json` from CWD):

```bash
pnpm dlx shadcn@latest add button card input label field input-otp
```

Generated files (one per primitive):

| Primitive | File | Used by |
|---|---|---|
| `button` | `packages/ui/src/components/button.tsx` | All three forms — submit + Google OAuth + resend. |
| `card` | `packages/ui/src/components/card.tsx` | Wrapper around each login form (`<Card>` + `<CardHeader>` + `<CardContent>`). |
| `input` | `packages/ui/src/components/input.tsx` | Email + password fields. |
| `label` | `packages/ui/src/components/label.tsx` | Field labels (used internally by `<FieldLabel>` and directly by `<InputOTP>` siblings). |
| `field` | `packages/ui/src/components/field.tsx` | Composition primitives: `<Field>`, `<FieldLabel>`, `<FieldError>`. |
| `input-otp` | `packages/ui/src/components/input-otp.tsx` | Six-segment OTP input on the verify-OTP form. |

The shadcn CLI auto-updates `packages/ui/package.json` with the Radix peer deps each primitive needs. **ADR-0008 is authored against that diff after the CLI runs** — not against guesswork.

## 6. Form pattern (canonical)

Every form follows this shape. The two-line summary: **zod schema declares the contract → `useForm` + `zodResolver` enforces it → `<Controller>` per field wires RHF state into `<Field>` markup.**

```tsx
'use client';

import { useForm, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';

import { Button } from '@rp/ui/components/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@rp/ui/components/card';
import { Input } from '@rp/ui/components/input';
import { Field, FieldLabel, FieldError } from '@rp/ui/components/field';

const schema = z.object({
  email: z.string().email('Enter a valid email'),
  password: z.string().min(12, 'At least 12 characters'),
});
type Values = z.infer<typeof schema>;

export function LoginForm() {
  const {
    control,
    handleSubmit,
    formState: { isSubmitting },
    setError,
  } = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: { email: '', password: '' },
  });

  async function onSubmit(values: Values) {
    const result = await signIn.email({ email: values.email, password: values.password, callbackURL: next });
    if (result.error) {
      setError('root', { message: result.error.message ?? 'Login failed' });
      return;
    }
    router.push(next as Route);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Welcome back</CardTitle>
        <CardDescription>Sign in to your platform account</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-4">
          <Controller
            control={control}
            name="email"
            render={({ field: rhfField, fieldState }) => (
              <Field>
                <FieldLabel htmlFor="email">Email</FieldLabel>
                <Input
                  id="email"
                  type="email"
                  autoComplete="email"
                  aria-invalid={fieldState.invalid}
                  {...rhfField}
                />
                {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
              </Field>
            )}
          />
          {/* …password Field… */}
          <Button type="submit" disabled={isSubmitting}>
            {isSubmitting ? 'Signing in…' : 'Sign in'}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
```

Key conventions:

- **`<FieldError>` shape from the modern shadcn RHF guide:** `{fieldState.invalid && <FieldError errors={[fieldState.error]} />}` — NOT `<FieldError>{fieldState.error?.message}</FieldError>`. The `errors={[...]}` prop is what the current `field.tsx` reads; the children-message shape is from older guides.
- **`aria-invalid`** mirrors `fieldState.invalid` (not `!!fieldState.error`) — same source of truth as the FieldError render.
- **Submit-level errors** (e.g. BA returns 401) go on `setError('root', ...)` and render via a small inline `<p>` (no `alert` primitive in v1, per Decision #8).
- **`isSubmitting`** controls submit `disabled` state; no separate `useState<loading>`.
- **`defaultValues`** are always declared so RHF treats the form as controlled from the first render.

## 7. Zod schemas (one per form)

| Form | Schema | Notes |
|---|---|---|
| Platform login | `z.object({ email: z.string().email(), password: z.string().min(12) })` | Min length matches `auth-core/platform.ts:emailAndPassword.minPasswordLength`. |
| Storefront login (OTP mode) | `z.object({ email: z.string().email() })` | Password field is hidden in this mode; schema doesn't carry it. |
| Storefront login (password mode) | `z.object({ email: z.string().email(), password: z.string().min(8) })` | Min length matches `auth-core/storefront.ts:emailAndPassword.minPasswordLength`. |
| Storefront verify OTP | `z.object({ otp: z.string().length(6).regex(/^\d{6}$/, 'Enter the 6-digit code') })` | Validates exactly 6 digits before BA round-trip. |

Schemas live colocated next to the form component they validate (e.g. exported from the same `login-form.tsx`) — DEL-2 doesn't introduce a shared schemas package.

## 8. File-by-file rewrite

### 8.1 [apps/platform/src/components/auth/login-form.tsx](../../apps/platform/src/components/auth/login-form.tsx)

- Replace `useState<email|password|error|loading>` with `useForm<Values>({ resolver: zodResolver(loginSchema) })`.
- Wrap the form in `<Card>` → `<CardHeader>` (`<CardTitle>Welcome back</CardTitle>` + `<CardDescription>Sign in to your platform account</CardDescription>`) → `<CardContent>`.
- Each input is `<Controller render={({field}) => <Field><FieldLabel/><Input {...field}/><FieldError/></Field>}/>`.
- Submit button: `<Button type="submit" disabled={isSubmitting}>`.
- Google button: `<Button variant="outline" onClick={handleGoogleLogin}>Continue with Google</Button>` (text-only, no icon).
- Keep: router/searchParams (`next ?? '/dashboard'`), BA call (`signIn.email`, `signIn.social`), forgot-password link (`/forgot-password`), the visual divider between password and Google.
- Drop the placeholder `// NOTE: Run pnpm dlx shadcn ...` comment at the top.

### 8.2 [apps/storefront/src/components/auth/login-form.tsx](../../apps/storefront/src/components/auth/login-form.tsx)

Same shape as platform, with these specifics:

- Mode toggle (`'otp'` ↔ `'password'`) stays on a local `useState<Mode>` in a thin parent component.
- **Schema-switching is implementation-safe via `key={mode}` remounting**, NOT `reset()` + a dynamically-chosen resolver. The cleanest shape:

  ```tsx
  function LoginForm() {
    const [mode, setMode] = useState<Mode>('otp');
    return (
      <>
        {mode === 'otp' ? <OtpForm key="otp" /> : <PasswordForm key="password" />}
        <button type="button" onClick={() => setMode(m => m === 'otp' ? 'password' : 'otp')}>
          {mode === 'otp' ? 'Sign in with password instead' : 'Sign in with a code instead'}
        </button>
      </>
    );
  }
  ```

  Each child (`OtpForm`, `PasswordForm`) has its own `useForm` + dedicated `zodResolver(otpSchema)` / `zodResolver(passwordSchema)`. Remounting on mode change side-steps RHF's resolver-swap edge cases (the resolver is captured at `useForm` time and isn't reactive on its own). Alternative: keep a single `<Form>` with `key={mode}` on its outer wrapper — equally valid; pick whichever reads more naturally during implementation.
- Two zod schemas exported from this file: `otpSchema` and `passwordSchema`.
- OTP submit calls `emailOtp.sendVerificationOtp({ email, type: 'sign-in' })` → push to `/verify-otp?email=&next=` (unchanged).
- Password submit calls `signIn.email(...)` (unchanged).
- Keep: mode-toggle link, Google OAuth button (text-only), sign-up link at the bottom.

### 8.3 [apps/storefront/src/components/auth/verify-otp-form.tsx](../../apps/storefront/src/components/auth/verify-otp-form.tsx)

- Replace the single `<input maxLength={6}>` with shadcn `<InputOTP maxLength={6}>` and six `<InputOTPSlot index={N}>` children.
- RHF `<Controller name="otp">` wires the value (string of digits) into BA's `signIn.emailOtp({ email, otp: values.otp })`.
- The submit button's `disabled` reflects both `isSubmitting` and `otpValue.length !== 6` (or relies on the zod schema to gate submission — pick at implementation time, the schema-gated path is cleaner).
- Keep: resend button (`emailOtp.sendVerificationOtp({ email, type: 'sign-in' })`), the title "Check your email" + the "We sent a 6-digit code to {email}" copy.

## 9. ADR-0008 outline

File: `docs/decisions/0008-shadcn-and-form-deps.md`. Numbering verified — 0001–0007 already present; 0008 is the next free integer.

The ADR's authoritative dep list comes from **the actual `package.json` diff produced by the shadcn CLI** plus the manual `pnpm add` lines from §3. Approximate enumeration (refined during implementation; the ADR is written *after* the install lands, not before):

- **Radix primitives** — exact set is whatever `shadcn add` writes into `packages/ui/package.json`. Likely `@radix-ui/react-label`, `@radix-ui/react-slot`; possibly others depending on the components. Do **not** pre-commit to `@radix-ui/react-icons`.
- **`react-hook-form`** — form state + per-field validation. Used by all three login forms; future signup forms (DEL-7) reuse the same pattern.
- **`@hookform/resolvers`** — zod ↔ RHF bridge.
- **`zod`** — declared in each consuming app (already in lockfile via auth-core).
- **`input-otp`** — vendored OTP input library shadcn wraps; small.
- **Already-in-tree, mentioned for completeness** — CVA, clsx, tailwind-merge, lucide-react.

**Rejected alternatives:** the older `components/ui/form.tsx` wrapper pattern (not the current docs' preferred Field-based RHF pattern — adopting it would anchor the codebase to vocabulary that's no longer where shadcn's docs point); Mantine / Chakra (different design system, conflicts with the shadcn / Tailwind / CSS-vars stack already in `packages/ui`); Formik (heavier, less RHF momentum).

## 10. Out of scope

- Brand theming per tenant (storefront pulling `brandingJson` colors into Tailwind tokens) — Phase 4-ish.
- Signup forms — [DEL-7](https://linear.app/oveglobal/issue/DEL-7).
- Forgot-password / reset-password page UI — separate issue or part of DEL-6.
- `alert` primitive — add when something needs a banner.
- Server actions wrapping BA APIs — separate concern; client-side BA calls stay as-is in DEL-2.
- New shadcn blocks beyond the six primitives listed in §5.

## 11. Verification checklist

Best-effort smoke tests:

- [ ] `pnpm -r typecheck` clean across the workspace.
- [ ] `pnpm lint` clean.
- [ ] `doppler run -- pnpm dev` boots both apps with no **new** DEL-2 runtime errors. Pre-existing dev-only noise — Next.js `experimental.typedRoutes` warning, multiple-lockfile root inference, missing Google OAuth creds — is expected and unrelated. *(Best-effort.)*
- [ ] `http://localhost:3000/login` renders cleanly — form inside a Card, both inputs styled, Google button present. *(Best-effort.)*
- [ ] `curl -H 'x-brand-slug: pizza-express' http://localhost:3001/login` returns HTML that includes the brand name and the new primitives' class names. *(Best-effort — confirms storefront brand-resolution still works through the new UI.)*
- [ ] Submit invalid email on `/login` (platform) — RHF surfaces a per-field `FieldError` ("Enter a valid email"), no submit happens, no network request. *(Best-effort.)*
- [ ] Submit valid `admin@test.local` + `Admin-Dev-Pass-1` on `/login` (platform) — redirected to `/dashboard` with a session. **Depends on the DEL-11 hotfix `generateId: 'uuid'` (PR #9) being present on the branch under test** — without it, sign-in 500s at the `platform_sessions` insert and the failure must be attributed to DEL-11, not DEL-2. Since DEL-11 + hotfix are in `main`, any DEL-2 branch off `main` or `staging` already includes it. *(Best-effort.)*
- [ ] Storefront `/login` mode toggle: switching between OTP and password modes remounts the keyed child form, clears prior values/errors, and reveals/hides the password field with the correct schema. *(Best-effort.)*
- [ ] `<InputOTP>` six-slot view on `/verify-otp` accepts digits only, auto-advances between slots, and submits at 6 digits. *(Best-effort.)*
