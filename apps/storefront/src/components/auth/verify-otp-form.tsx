'use client';

/**
 * Storefront verify-OTP form — 6-digit code entry via shadcn InputOTP.
 *
 * Structured after shadcn login-01 (FieldGroup wrapper, single outer Field
 * for actions, no divider). InputOTP slot stays centered inside its Field.
 * RHF + zod preserved per docs/specs/ui-foundations.md §6.
 */

import { zodResolver } from '@hookform/resolvers/zod';
import type { Route } from 'next';
import { useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { z } from 'zod';

import { safeNextPath } from '@rp/auth-core/safe-next-path';
import { Button } from '@rp/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@rp/ui/components/card';
import { Field, FieldError, FieldGroup } from '@rp/ui/components/field';
import { InputOTP, InputOTPGroup, InputOTPSlot } from '@rp/ui/components/input-otp';

import { emailOtp, signIn } from '@/lib/auth-client';

const verifySchema = z.object({
  otp: z
    .string()
    .length(6, 'Enter the 6-digit code')
    .regex(/^\d{6}$/, 'Code must be 6 digits'),
});
type VerifyValues = z.infer<typeof verifySchema>;

export function VerifyOtpForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const email = searchParams.get('email') ?? '';
  const next = safeNextPath(searchParams.get('next'), '/account');
  // DEL-7 §5d/§5e: storefront signup threads name via ?name=&signup=true.
  // BA's signIn.emailOtp accepts optional `name` and uses it ONLY when
  // creating a first-time user — exactly the storefront signup intent.
  const signupName = searchParams.get('signup') === 'true' ? searchParams.get('name') : null;

  const [resending, setResending] = useState(false);

  const {
    control,
    handleSubmit,
    formState: { errors, isSubmitting },
    setError,
  } = useForm<VerifyValues>({
    resolver: zodResolver(verifySchema),
    defaultValues: { otp: '' },
  });

  async function onSubmit(values: VerifyValues) {
    try {
      const result = await signIn.emailOtp({
        email,
        otp: values.otp,
        ...(signupName ? { name: signupName } : {}),
      });

      if (result.error) {
        setError('root', {
          message: result.error.message ?? 'Invalid code',
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

  async function handleResend() {
    setResending(true);
    try {
      await emailOtp.sendVerificationOtp({ email, type: 'sign-in' });
    } finally {
      setResending(false);
    }
  }

  return (
    <Card>
      <CardHeader className="text-center">
        <CardTitle>Check your email</CardTitle>
        <CardDescription>We sent a 6-digit code to {email}</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit(onSubmit)} noValidate>
          <FieldGroup>
            <Controller
              control={control}
              name="otp"
              render={({ field: rhfField, fieldState }) => (
                <Field className="items-center">
                  <InputOTP
                    maxLength={6}
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    aria-invalid={fieldState.invalid}
                    value={rhfField.value}
                    onChange={rhfField.onChange}
                    onBlur={rhfField.onBlur}
                  >
                    <InputOTPGroup>
                      <InputOTPSlot index={0} />
                      <InputOTPSlot index={1} />
                      <InputOTPSlot index={2} />
                      <InputOTPSlot index={3} />
                      <InputOTPSlot index={4} />
                      <InputOTPSlot index={5} />
                    </InputOTPGroup>
                  </InputOTP>
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
                {isSubmitting ? 'Verifying…' : 'Verify'}
              </Button>
              <Button
                type="button"
                variant="link"
                onClick={handleResend}
                disabled={isSubmitting || resending}
              >
                {resending ? 'Sending…' : "Didn't get a code? Resend"}
              </Button>
            </Field>
          </FieldGroup>
        </form>
      </CardContent>
    </Card>
  );
}
