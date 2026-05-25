'use client';

/**
 * Storefront login form — hybrid auth:
 *   1. OTP (primary): email → 6-digit code → /verify-otp
 *   2. Password fallback: email + password → /account
 *   3. Google OAuth
 *
 * Mode switching uses keyed child forms (see docs/specs/ui-foundations.md
 * §8.2) — each child has its own useForm + zodResolver, so RHF re-initializes
 * cleanly on switch without resolver-swap edge cases.
 */

import { zodResolver } from '@hookform/resolvers/zod';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import type { Route } from 'next';
import { useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { z } from 'zod';

import { Button } from '@rp/ui/components/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@rp/ui/components/card';
import { Field, FieldError, FieldLabel } from '@rp/ui/components/field';
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
  const [googleLoading, setGoogleLoading] = useState(false);
  const searchParams = useSearchParams();
  const next = searchParams.get('next') ?? '/account';

  async function handleGoogleLogin() {
    setGoogleLoading(true);
    await signIn.social({ provider: 'google', callbackURL: next });
  }

  return (
    <Card className="w-full max-w-sm">
      <CardHeader>
        <CardTitle>Sign in</CardTitle>
        <CardDescription>
          {mode === 'otp'
            ? "We'll email you a 6-digit code"
            : 'Use your email and password'}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {mode === 'otp' ? (
          <OtpForm key="otp" next={next} />
        ) : (
          <PasswordForm key="password" next={next} />
        )}

        <button
          type="button"
          onClick={() => setMode(mode === 'otp' ? 'password' : 'otp')}
          className="text-muted-foreground mt-4 w-full text-sm hover:underline"
        >
          {mode === 'otp'
            ? 'Sign in with password instead'
            : 'Sign in with a code instead'}
        </button>

        <div className="relative my-6">
          <div className="absolute inset-0 flex items-center">
            <span className="w-full border-t" />
          </div>
          <div className="relative flex justify-center text-xs uppercase">
            <span className="bg-card text-muted-foreground px-2">Or</span>
          </div>
        </div>

        <Button
          type="button"
          variant="outline"
          className="w-full"
          onClick={handleGoogleLogin}
          disabled={googleLoading}
        >
          Continue with Google
        </Button>

        <p className="text-muted-foreground mt-6 text-center text-sm">
          Don&apos;t have an account?{' '}
          <Link href={'/signup' as Route} className="underline">
            Sign up
          </Link>
        </p>
      </CardContent>
    </Card>
  );
}

function OtpForm({ next }: { next: string }) {
  const router = useRouter();

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

  return (
    <form
      onSubmit={handleSubmit(onSubmit)}
      className="flex flex-col gap-4"
      noValidate
    >
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

      <Button type="submit" disabled={isSubmitting}>
        {isSubmitting ? 'Sending…' : 'Send code'}
      </Button>
    </form>
  );
}

function PasswordForm({ next }: { next: string }) {
  const router = useRouter();

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

      router.push(next as Route);
    } catch (err) {
      setError('root', {
        message: err instanceof Error ? err.message : 'Unknown error',
      });
    }
  }

  return (
    <form
      onSubmit={handleSubmit(onSubmit)}
      className="flex flex-col gap-4"
      noValidate
    >
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
            <FieldLabel htmlFor="pw-password">Password</FieldLabel>
            <Input
              id="pw-password"
              type="password"
              autoComplete="current-password"
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

      <Button type="submit" disabled={isSubmitting}>
        {isSubmitting ? 'Signing in…' : 'Sign in'}
      </Button>
    </form>
  );
}
