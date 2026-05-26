'use client';

/**
 * Platform signup form — invite-token-driven.
 *
 * Reads `?token=<invitationId>` from query. Calls `signUp.email` with a
 * `callbackURL` of `/dashboard?accept=<token>` so that after BA's
 * sendOnSignUp verification email is clicked + autoSignIn fires, the
 * user lands on /dashboard where the AcceptInvitationHook calls
 * `organization.acceptInvitation({ invitationId })`.
 *
 * If `?token=` is missing, the form renders an error state — platform
 * signup is invite-only per docs/auth-spec.md §4.
 */

import { zodResolver } from '@hookform/resolvers/zod';
import type { Route } from 'next';
import { useSearchParams } from 'next/navigation';
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

import { signUp } from '@/lib/auth-client';

const signupSchema = z.object({
  name: z.string().min(1, 'Enter your name'),
  email: z.string().email('Enter a valid email'),
  password: z.string().min(12, 'At least 12 characters'),
});
type SignupValues = z.infer<typeof signupSchema>;

export function SignupForm() {
  const searchParams = useSearchParams();
  const token = searchParams.get('token');

  const {
    control,
    handleSubmit,
    formState: { errors, isSubmitting, isSubmitSuccessful },
    setError,
  } = useForm<SignupValues>({
    resolver: zodResolver(signupSchema),
    defaultValues: { name: '', email: '', password: '' },
  });

  if (!token) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Invitation required</CardTitle>
          <CardDescription>
            Platform signup is invite-only. Please use the link from your invitation email.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  async function onSubmit(values: SignupValues) {
    try {
      const callbackURL: Route = `/dashboard?accept=${encodeURIComponent(token ?? '')}` as Route;
      const result = await signUp.email({
        email: values.email,
        password: values.password,
        name: values.name,
        callbackURL,
      });

      if (result.error) {
        setError('root', { message: result.error.message ?? 'Sign-up failed' });
        return;
      }
      // BA fires sendVerificationEmail on signup (sendOnSignUp: true). User
      // verifies email → autoSignIn → redirected to callbackURL → accept hook
      // finalizes. We render a "check your email" state below.
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
            We&apos;ve sent a verification link to your email. Click it to finish setting up your
            account.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Create your account</CardTitle>
        <CardDescription>You&apos;ve been invited. Set up your credentials below.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit(onSubmit)} noValidate>
          <FieldGroup>
            <Controller
              control={control}
              name="name"
              render={({ field: rhfField, fieldState }) => (
                <Field>
                  <FieldLabel htmlFor="name">Name</FieldLabel>
                  <Input
                    id="name"
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
                  <FieldLabel htmlFor="password">Password</FieldLabel>
                  <Input
                    id="password"
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

            {errors.root && (
              <p className="text-destructive text-sm" role="alert">
                {errors.root.message}
              </p>
            )}

            <Field>
              <Button type="submit" disabled={isSubmitting}>
                {isSubmitting ? 'Creating account…' : 'Create account'}
              </Button>
            </Field>
          </FieldGroup>
        </form>
      </CardContent>
    </Card>
  );
}
