'use client';

/**
 * Platform reset-password form.
 *
 * Reads `?token=...` from query (BA's GET /api/auth/reset-password/<token>
 * validates the token and redirects to redirectTo + `?token=<token>`). Calls
 * `authClient.resetPassword({ newPassword, token })` to finalize.
 */

import { zodResolver } from '@hookform/resolvers/zod';
import type { Route } from 'next';
import { useRouter, useSearchParams } from 'next/navigation';
import { Controller, useForm } from 'react-hook-form';
import { z } from 'zod';

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

import { authClient } from '@/lib/auth-client';

const resetSchema = z
  .object({
    newPassword: z.string().min(12, 'At least 12 characters'),
    confirmPassword: z.string(),
  })
  .refine((data) => data.newPassword === data.confirmPassword, {
    message: 'Passwords do not match',
    path: ['confirmPassword'],
  });
type ResetValues = z.infer<typeof resetSchema>;

export function ResetPasswordForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const token = searchParams.get('token');

  const {
    control,
    handleSubmit,
    formState: { errors, isSubmitting },
    setError,
  } = useForm<ResetValues>({
    resolver: zodResolver(resetSchema),
    defaultValues: { newPassword: '', confirmPassword: '' },
  });

  if (!token) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Invalid link</CardTitle>
          <CardDescription>
            This reset link is missing a token. Request a new password-reset email and try again.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  async function onSubmit(values: ResetValues) {
    try {
      const result = await authClient.resetPassword({
        newPassword: values.newPassword,
        token: token ?? '',
      });
      if (result.error) {
        setError('root', {
          message:
            result.error.message ?? 'This link is no longer valid. Please request a new one.',
        });
        return;
      }
      router.push('/login?reset=success' as Route);
    } catch (err) {
      setError('root', {
        message: err instanceof Error ? err.message : 'Unknown error',
      });
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Reset your password</CardTitle>
        <CardDescription>Choose a new password for your account.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit(onSubmit)} noValidate>
          <FieldGroup>
            <Controller
              control={control}
              name="newPassword"
              render={({ field: rhfField, fieldState }) => (
                <Field>
                  <FieldLabel htmlFor="newPassword">New password</FieldLabel>
                  <Input
                    id="newPassword"
                    type="password"
                    autoComplete="new-password"
                    required
                    aria-invalid={fieldState.invalid}
                    {...rhfField}
                  />
                  <FieldDescription>At least 12 characters.</FieldDescription>
                  {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
                </Field>
              )}
            />

            <Controller
              control={control}
              name="confirmPassword"
              render={({ field: rhfField, fieldState }) => (
                <Field>
                  <FieldLabel htmlFor="confirmPassword">Confirm password</FieldLabel>
                  <Input
                    id="confirmPassword"
                    type="password"
                    autoComplete="new-password"
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
                {isSubmitting ? 'Resetting…' : 'Reset password'}
              </Button>
            </Field>
          </FieldGroup>
        </form>
      </CardContent>
    </Card>
  );
}
