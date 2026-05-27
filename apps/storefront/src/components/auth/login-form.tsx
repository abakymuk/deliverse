'use client';

/**
 * Storefront login form — hybrid auth:
 *   1. OTP (primary): email → 6-digit code → /verify-otp
 *   2. Password fallback: email + password → /account
 *   3. Google OAuth
 *
 * Structured after shadcn login-01 (FieldGroup + single outer Field for
 * actions + footer; no "Or continue with" divider). Mode toggle lives as a
 * link-variant button between the primary action and Google OAuth so OTP
 * stays the visible default. Keyed child forms (one per mode) ensure RHF
 * re-initializes cleanly on switch.
 */

import { zodResolver } from '@hookform/resolvers/zod';
import type { Route } from 'next';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
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

import { emailOtp, signIn } from '@/lib/auth-client';

const otpSchema = z.object({
  email: z.string().email('Enter a valid email'),
});
type OtpValues = z.infer<typeof otpSchema>;

const passwordSchema = z.object({
  email: z.string().email('Enter a valid email'),
  password: z.string().min(8, 'At least 8 characters'),
});
type PasswordValues = z.infer<typeof passwordSchema>;

type Mode = 'otp' | 'password';

export function LoginForm() {
  const [mode, setMode] = useState<Mode>('otp');
  const searchParams = useSearchParams();
  const next = safeNextPath(searchParams.get('next'), '/account');

  function toggleMode() {
    setMode((m) => (m === 'otp' ? 'password' : 'otp'));
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Sign in</CardTitle>
        <CardDescription>
          {mode === 'otp' ? "We'll email you a 6-digit code" : 'Use your email and password'}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {mode === 'otp' ? (
          <OtpForm key="otp" next={next} onToggleMode={toggleMode} />
        ) : (
          <PasswordForm key="password" next={next} onToggleMode={toggleMode} />
        )}
      </CardContent>
    </Card>
  );
}

function OtpForm({
  next,
  onToggleMode,
}: {
  next: string;
  onToggleMode: () => void;
}) {
  const router = useRouter();
  const [googleLoading, setGoogleLoading] = useState(false);

  const {
    control,
    handleSubmit,
    formState: { errors, isSubmitting },
    setError,
  } = useForm<OtpValues>({
    resolver: zodResolver(otpSchema),
    defaultValues: { email: '' },
  });

  async function onSubmit(values: OtpValues) {
    try {
      const result = await emailOtp.sendVerificationOtp({
        email: values.email,
        type: 'sign-in',
      });

      if (result.error) {
        setError('root', {
          message: result.error.message ?? 'Could not send code',
        });
        return;
      }

      const params = new URLSearchParams({ email: values.email, next });
      router.push(`/verify-otp?${params.toString()}` as Route);
    } catch (err) {
      setError('root', {
        message: err instanceof Error ? err.message : 'Unknown error',
      });
    }
  }

  async function handleGoogleLogin() {
    setGoogleLoading(true);
    try {
      const result = await signIn.social({ provider: 'google', callbackURL: next });
      if (result?.error) {
        setError('root', {
          message: result.error.message ?? 'Google sign-in failed',
        });
      }
    } catch (err) {
      setError('root', {
        message: err instanceof Error ? err.message : 'Google sign-in failed',
      });
    } finally {
      // DEL-23: reset loading state on error/cancel paths that don't redirect.
      // Without `finally`, an unsuccessful social flow leaves the button stuck.
      setGoogleLoading(false);
    }
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} noValidate>
      <FieldGroup>
        <Controller
          control={control}
          name="email"
          render={({ field: rhfField, fieldState }) => (
            <Field>
              <FieldLabel htmlFor="otp-email">Email</FieldLabel>
              <Input
                id="otp-email"
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
          <Button type="button" variant="link" onClick={onToggleMode}>
            Sign in with password instead
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={handleGoogleLogin}
            disabled={googleLoading || isSubmitting}
          >
            Continue with Google
          </Button>
          <FieldDescription className="text-center">
            Don&apos;t have an account?{' '}
            <Link href={'/signup' as Route} className="underline">
              Sign up
            </Link>
          </FieldDescription>
        </Field>
      </FieldGroup>
    </form>
  );
}

function PasswordForm({
  next,
  onToggleMode,
}: {
  next: string;
  onToggleMode: () => void;
}) {
  const [googleLoading, setGoogleLoading] = useState(false);

  const {
    control,
    handleSubmit,
    formState: { errors, isSubmitting },
    setError,
  } = useForm<PasswordValues>({
    resolver: zodResolver(passwordSchema),
    defaultValues: { email: '', password: '' },
  });

  async function onSubmit(values: PasswordValues) {
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
      // success — see DEL-17 note in platform login-form.tsx for the cookie-
      // persistence rationale.
    } catch (err) {
      setError('root', {
        message: err instanceof Error ? err.message : 'Unknown error',
      });
    }
  }

  async function handleGoogleLogin() {
    setGoogleLoading(true);
    try {
      const result = await signIn.social({ provider: 'google', callbackURL: next });
      if (result?.error) {
        setError('root', {
          message: result.error.message ?? 'Google sign-in failed',
        });
      }
    } catch (err) {
      setError('root', {
        message: err instanceof Error ? err.message : 'Google sign-in failed',
      });
    } finally {
      // DEL-23: reset loading state on error/cancel paths that don't redirect.
      // Without `finally`, an unsuccessful social flow leaves the button stuck.
      setGoogleLoading(false);
    }
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} noValidate>
      <FieldGroup>
        <Controller
          control={control}
          name="email"
          render={({ field: rhfField, fieldState }) => (
            <Field>
              <FieldLabel htmlFor="pw-email">Email</FieldLabel>
              <Input
                id="pw-email"
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
                <FieldLabel htmlFor="pw-password">Password</FieldLabel>
                <Link
                  href={'/forgot-password' as Route}
                  className="ml-auto inline-block text-sm underline-offset-4 hover:underline"
                >
                  Forgot your password?
                </Link>
              </div>
              <Input
                id="pw-password"
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
          <Button type="button" variant="link" onClick={onToggleMode}>
            Sign in with a code instead
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={handleGoogleLogin}
            disabled={googleLoading || isSubmitting}
          >
            Continue with Google
          </Button>
          <FieldDescription className="text-center">
            Don&apos;t have an account?{' '}
            <Link href={'/signup' as Route} className="underline">
              Sign up
            </Link>
          </FieldDescription>
        </Field>
      </FieldGroup>
    </form>
  );
}
