'use client';

/**
 * Platform login form
 * Based on shadcn/ui block: https://ui.shadcn.com/blocks/login
 *
 * Methods:
 *   - Email + password
 *   - Google OAuth
 *
 * NOTE: Run `pnpm dlx shadcn@latest add button card input label` in packages/ui
 * to add the actual shadcn components. This file uses placeholder imports.
 */

import { useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { signIn } from '@/lib/auth-client';

export function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const next = searchParams.get('next') ?? '/dashboard';

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

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
    await signIn.social({
      provider: 'google',
      callbackURL: next,
    });
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2 text-center">
        <h1 className="text-2xl font-bold">Welcome back</h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">
          Sign in to your platform account
        </p>
      </div>

      <form onSubmit={handlePasswordLogin} className="flex flex-col gap-4">
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

        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <label htmlFor="password" className="text-sm font-medium">
              Password
            </label>
            <Link
              href="/forgot-password"
              className="text-sm text-[var(--color-muted-foreground)] hover:underline"
            >
              Forgot password?
            </Link>
          </div>
          <input
            id="password"
            type="password"
            autoComplete="current-password"
            required
            minLength={12}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="rounded-md border px-3 py-2"
          />
        </div>

        {error && (
          <p className="text-sm text-[var(--color-destructive)]">{error}</p>
        )}

        <button
          type="submit"
          disabled={loading}
          className="rounded-md bg-[var(--color-primary)] py-2 text-[var(--color-primary-foreground)] disabled:opacity-50"
        >
          {loading ? 'Signing in...' : 'Sign in'}
        </button>
      </form>

      <div className="relative">
        <div className="absolute inset-0 flex items-center">
          <span className="w-full border-t" />
        </div>
        <div className="relative flex justify-center text-xs uppercase">
          <span className="bg-[var(--color-background)] px-2 text-[var(--color-muted-foreground)]">
            Or continue with
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
    </div>
  );
}
