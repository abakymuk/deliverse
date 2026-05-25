'use client';

/**
 * Storefront verify-OTP form — 6-digit code entry via shadcn InputOTP.
 *
 * Modern shadcn React Hook Form + Field pattern. See
 * docs/specs/ui-foundations.md §6 + §8.3.
 */

import { zodResolver } from '@hookform/resolvers/zod';
import { useRouter, useSearchParams } from 'next/navigation';
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
import { Field, FieldError } from '@rp/ui/components/field';
import {
  InputOTP,
  InputOTPGroup,
  InputOTPSlot,
} from '@rp/ui/components/input-otp';

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
  const next = searchParams.get('next') ?? '/account';

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
      const result = await signIn.emailOtp({ email, otp: values.otp });

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
    <Card className="w-full max-w-sm">
      <CardHeader className="text-center">
        <CardTitle>Check your email</CardTitle>
        <CardDescription>
          We sent a 6-digit code to {email}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          onSubmit={handleSubmit(onSubmit)}
          className="flex flex-col gap-4"
          noValidate
        >
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
                {fieldState.invalid && (
                  <FieldError errors={[fieldState.error]} />
                )}
              </Field>
            )}
          />

          {errors.root && (
            <p className="text-destructive text-sm" role="alert">
              {errors.root.message}
            </p>
          )}

          <Button type="submit" disabled={isSubmitting}>
            {isSubmitting ? 'Verifying…' : 'Verify'}
          </Button>

          <button
            type="button"
            onClick={handleResend}
            disabled={isSubmitting || resending}
            className="text-muted-foreground text-sm hover:underline disabled:opacity-50"
          >
            {resending ? 'Sending…' : "Didn't get a code? Resend"}
          </button>
        </form>
      </CardContent>
    </Card>
  );
}
