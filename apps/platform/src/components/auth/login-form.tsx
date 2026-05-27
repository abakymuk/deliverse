'use client';

/**
 * Platform login form — email/password + Google OAuth.
 *
 * Structured after shadcn login-01 (FieldGroup + single outer Field for
 * actions + footer description; no "Or continue with" divider). RHF + zod
 * preserved per docs/specs/ui-foundations.md §6.
 */

import { zodResolver } from '@hookform/resolvers/zod';
import type { Route } from 'next';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { z } from 'zod';

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

import { signIn } from '@/lib/auth-client';

const loginSchema = z.object({
  email: z.string().email('Enter a valid email'),
  password: z.string().min(12, 'At least 12 characters'),
});
type LoginValues = z.infer<typeof loginSchema>;

export function LoginForm() {
  const searchParams = useSearchParams();
  const next = safeNextPath(searchParams.get('next'), '/dashboard');

  const [googleLoading, setGoogleLoading] = useState(false);

  const {
    control,
    handleSubmit,
    formState: { errors, isSubmitting },
    setError,
  } = useForm<LoginValues>({
    resolver: zodResolver(loginSchema),
    defaultValues: { email: '', password: '' },
  });

  async function onSubmit(values: LoginValues) {
    try {
      const result = await signIn.email({
        email: values.email,
        password: values.password,
        callbackURL: next,
      });

      if (result.error) {
        setError('root', {
          message: result.error.message ?? 'Login failed',
        });
        return;
      }

      // BA's redirect plugin handles navigation via window.location.href on
      // success — a full reload, which guarantees the Set-Cookie response is
      // persisted before the next request. Calling router.push here races the
      // plugin (DEL-17 / DEL-8 CI repro): soft-nav can fire its request before
      // Chromium headless persists the cookie, server-side session check sees
      // nothing, bounces back to /login.
    } catch (err) {
      setError('root', {
        message: err instanceof Error ? err.message : 'Unknown error',
      });
    }
  }

  async function handleGoogleLogin() {
    setGoogleLoading(true);
    await signIn.social({ provider: 'google', callbackURL: next });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Login to your account</CardTitle>
        <CardDescription>Enter your email below to login to your account</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit(onSubmit)} noValidate>
          <FieldGroup>
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
                    placeholder="m@example.com"
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
              name="password"
              render={({ field: rhfField, fieldState }) => (
                <Field>
                  <div className="flex items-center">
                    <FieldLabel htmlFor="password">Password</FieldLabel>
                    <Link
                      href={'/forgot-password' as Route}
                      className="ml-auto inline-block text-sm underline-offset-4 hover:underline"
                    >
                      Forgot your password?
                    </Link>
                  </div>
                  <Input
                    id="password"
                    type="password"
                    autoComplete="current-password"
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
                {isSubmitting ? 'Signing in…' : 'Login'}
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={handleGoogleLogin}
                disabled={googleLoading || isSubmitting}
              >
                Login with Google
              </Button>
              <FieldDescription className="text-center">
                Need access? Contact your admin.
              </FieldDescription>
            </Field>
          </FieldGroup>
        </form>
      </CardContent>
    </Card>
  );
}
