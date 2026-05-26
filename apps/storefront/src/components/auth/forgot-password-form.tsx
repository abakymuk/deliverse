'use client';

/**
 * Storefront forgot-password form.
 *
 * Same shape as platform forgot-password — calls
 * `authClient.requestPasswordReset({ email, redirectTo: '/reset-password' })`
 * with enumeration-safe success copy regardless of email existence.
 * BA's `redirectTo` is mandatory (`password.mjs:115`).
 */

import { zodResolver } from '@hookform/resolvers/zod';
import { Controller, useForm } from 'react-hook-form';
import { z } from 'zod';

import { Button } from '@rp/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@rp/ui/components/card';
import { Field, FieldError, FieldGroup, FieldLabel } from '@rp/ui/components/field';
import { Input } from '@rp/ui/components/input';

import { authClient } from '@/lib/auth-client';

const forgotSchema = z.object({
  email: z.string().email('Enter a valid email'),
});
type ForgotValues = z.infer<typeof forgotSchema>;

export function ForgotPasswordForm() {
  const {
    control,
    handleSubmit,
    formState: { errors, isSubmitting, isSubmitSuccessful },
    setError,
  } = useForm<ForgotValues>({
    resolver: zodResolver(forgotSchema),
    defaultValues: { email: '' },
  });

  async function onSubmit(values: ForgotValues) {
    try {
      const result = await authClient.requestPasswordReset({
        email: values.email,
        redirectTo: '/reset-password',
      });
      if (result.error) {
        setError('root', { message: result.error.message ?? 'Could not send reset link' });
      }
    } catch (err) {
      setError('root', {
        message: err instanceof Error ? err.message : 'Unknown error',
      });
    }
  }

  if (isSubmitSuccessful && !errors.root) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Check your email</CardTitle>
          <CardDescription>
            If an account exists for that email, we&apos;ve sent a link to reset the password. Check
            your inbox.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Forgot your password?</CardTitle>
        <CardDescription>
          Enter your email and we&apos;ll send a link to reset your password.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit(onSubmit)} noValidate>
          <FieldGroup>
            <Controller
              control={control}
              name="email"
              render={({ field: rhfField, fieldState }) => (
                <Field>
                  <FieldLabel htmlFor="forgot-email">Email</FieldLabel>
                  <Input
                    id="forgot-email"
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
                {isSubmitting ? 'Sending…' : 'Send reset link'}
              </Button>
            </Field>
          </FieldGroup>
        </form>
      </CardContent>
    </Card>
  );
}
