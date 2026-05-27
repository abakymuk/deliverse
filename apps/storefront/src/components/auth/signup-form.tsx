'use client';

/**
 * Storefront signup form — OTP-driven (no password, no Google).
 *
 * Per docs/specs/auth-ui.md §5d: collects email + name, calls
 * `emailOtp.sendVerificationOtp({ email, type: 'sign-in' })` (BA's OTP
 * plugin lazy-creates the user on verify per `disableSignUp: false`),
 * then redirects to `/verify-otp?email=<email>&name=<name>&next=/account&signup=true`.
 *
 * BA's `sendVerificationOtp` ignores `name`; the verify step
 * (verify-otp-form.tsx) passes it to `signIn.emailOtp({ email, otp, name })`
 * — only used for first-time user creation.
 *
 * Storefront signup is OTP-only because DEL-12 hasn't tenant-scoped the
 * accounts table yet — Google button intentionally absent (still on login
 * form for existing OAuth users).
 */

import { zodResolver } from '@hookform/resolvers/zod';
import type { Route } from 'next';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Controller, useForm } from 'react-hook-form';
import { z } from 'zod';

import type { Brand } from '@rp/db';
import { safeNextPath } from '@rp/auth-core/safe-next-path';
import { Button } from '@rp/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@rp/ui/components/card';
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from '@rp/ui/components/field';
import { Input } from '@rp/ui/components/input';

import { emailOtp } from '@/lib/auth-client';

const signupSchema = z.object({
  name: z.string().min(1, 'Enter your name'),
  email: z.string().email('Enter a valid email'),
});
type SignupValues = z.infer<typeof signupSchema>;

export type SignupFormProps = {
  /**
   * Brand-host context (mode 1/2). When set, the form heading is
   * "Create your {brand.name} account."
   */
  brand?: Brand;
  /**
   * Tenant-host context (mode 3 — food-hall). DEL-25 PR 25b. Used as
   * the heading when no `brand` is supplied. Either `brand` or
   * `storefrontName` should be set; if both are omitted, heading falls
   * back to a generic "Create your account".
   */
  storefrontName?: string;
};

export function SignupForm({ brand, storefrontName }: SignupFormProps = {}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const rawNext = searchParams.get('next');
  const next = safeNextPath(rawNext, '/account');

  // Propagate the explicit `next` back to /login if the user came here from a
  // deep-link redirect (e.g., /login?next=/checkout → /signup?next=/checkout
  // → /login?next=/checkout). When no `next` was supplied, the /login link
  // stays plain.
  const loginHref = (
    rawNext ? `/login?next=${encodeURIComponent(next)}` : '/login'
  ) as Route;

  const {
    control,
    handleSubmit,
    formState: { errors, isSubmitting },
    setError,
  } = useForm<SignupValues>({
    resolver: zodResolver(signupSchema),
    defaultValues: { name: '', email: '' },
  });

  async function onSubmit(values: SignupValues) {
    try {
      const result = await emailOtp.sendVerificationOtp({
        email: values.email,
        type: 'sign-in',
      });

      if (result.error) {
        setError('root', { message: result.error.message ?? 'Could not send code' });
        return;
      }

      const params = new URLSearchParams({
        email: values.email,
        name: values.name,
        next,
        signup: 'true',
      });
      router.push(`/verify-otp?${params.toString()}` as Route);
    } catch (err) {
      setError('root', {
        message: err instanceof Error ? err.message : 'Unknown error',
      });
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          Create your {brand?.name ?? storefrontName ?? ''} account
        </CardTitle>
        <CardDescription>We&apos;ll send a 6-digit code to verify your email.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit(onSubmit)} noValidate>
          <FieldGroup>
            <Controller
              control={control}
              name="name"
              render={({ field: rhfField, fieldState }) => (
                <Field>
                  <FieldLabel htmlFor="signup-name">Name</FieldLabel>
                  <Input
                    id="signup-name"
                    type="text"
                    autoComplete="name"
                    required
                    aria-invalid={fieldState.invalid}
                    {...rhfField}
                  />
                  {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
                </Field>
              )}
            />

            <Controller
              control={control}
              name="email"
              render={({ field: rhfField, fieldState }) => (
                <Field>
                  <FieldLabel htmlFor="signup-email">Email</FieldLabel>
                  <Input
                    id="signup-email"
                    type="email"
                    autoComplete="email"
                    placeholder="m@example.com"
                    required
                    aria-invalid={fieldState.invalid}
                    {...rhfField}
                  />
                  {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
                </Field>
              )}
            />

            {errors.root && (
              <p className="text-destructive text-sm" role="alert">
                {errors.root.message}
              </p>
            )}

            <Field>
              <Button type="submit" disabled={isSubmitting}>
                {isSubmitting ? 'Sending…' : 'Send code'}
              </Button>
              <FieldDescription className="text-center">
                Already have an account?{' '}
                <Link href={loginHref} className="underline-offset-4 hover:underline">
                  Sign in
                </Link>
              </FieldDescription>
            </Field>
          </FieldGroup>
        </form>
      </CardContent>
    </Card>
  );
}
