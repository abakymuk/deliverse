'use client';

/**
 * Storefront login form — hybrid auth:
 *
 * Flow:
 *   1. User enters email
 *   2. Default: send OTP (primary)
 *   3. Alternative link: "Sign in with password" → reveals password field
 *   4. Alternative: Google OAuth
 *
 * Based on shadcn/ui login block, customized for OTP-first.
 */

import { useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { signIn, emailOtp } from '@/lib/auth-client';

type Mode = 'otp' | 'password';

export function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const next = searchParams.get('next') ?? '/account';

  const [mode, setMode] = useState<Mode>('otp');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleOtpRequest(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const result = await emailOtp.sendVerificationOtp({
        email,
        type: 'sign-in',
      });

      if (result.error) {
        setError(result.error.message ?? 'Could not send code');
        return;
      }

      // Redirect to verify-otp page with email in query
      const params = new URLSearchParams({ email, next });
      router.push(`/verify-otp?${params.toString()}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }

  async function handlePasswordLogin(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const result = await signIn.email({
        email,
        password,
        callbackURL: next,
      });

      if (result.error) {
        setError(result.error.message ?? 'Login failed');
        return;
      }

      router.push(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }

  async function handleGoogleLogin() {
    setLoading(true);
    await signIn.social({ provider: 'google', callbackURL: next });
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2 text-center">
        <h2 className="text-lg font-semibold">Sign in</h2>
        <p className="text-sm text-[var(--color-muted-foreground)]">
          {mode === 'otp'
            ? "We'll email you a 6-digit code"
            : 'Use your email and password'}
        </p>
      </div>

      <form
        onSubmit={mode === 'otp' ? handleOtpRequest : handlePasswordLogin}
        className="flex flex-col gap-4"
      >
        <div className="flex flex-col gap-2">
          <label htmlFor="email" className="text-sm font-medium">
            Email
          </label>
          <input
            id="email"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="rounded-md border px-3 py-2"
          />
        </div>

        {mode === 'password' && (
          <div className="flex flex-col gap-2">
            <label htmlFor="password" className="text-sm font-medium">
              Password
            </label>
            <input
              id="password"
              type="password"
              autoComplete="current-password"
              required
              minLength={8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="rounded-md border px-3 py-2"
            />
          </div>
        )}

        {error && (
          <p className="text-sm text-[var(--color-destructive)]">{error}</p>
        )}

        <button
          type="submit"
          disabled={loading}
          className="rounded-md bg-[var(--color-primary)] py-2 text-[var(--color-primary-foreground)] disabled:opacity-50"
        >
          {loading
            ? 'Loading...'
            : mode === 'otp'
              ? 'Send code'
              : 'Sign in'}
        </button>

        <button
          type="button"
          onClick={() => {
            setMode(mode === 'otp' ? 'password' : 'otp');
            setError(null);
          }}
          className="text-sm text-[var(--color-muted-foreground)] hover:underline"
        >
          {mode === 'otp'
            ? 'Sign in with password instead'
            : 'Sign in with a code instead'}
        </button>
      </form>

      <div className="relative">
        <div className="absolute inset-0 flex items-center">
          <span className="w-full border-t" />
        </div>
        <div className="relative flex justify-center text-xs uppercase">
          <span className="bg-[var(--color-background)] px-2 text-[var(--color-muted-foreground)]">
            Or
          </span>
        </div>
      </div>

      <button
        type="button"
        onClick={handleGoogleLogin}
        disabled={loading}
        className="rounded-md border py-2 disabled:opacity-50"
      >
        Continue with Google
      </button>

      <p className="text-center text-sm text-[var(--color-muted-foreground)]">
        Don't have an account?{' '}
        <Link href="/signup" className="underline">
          Sign up
        </Link>
      </p>
    </div>
  );
}
