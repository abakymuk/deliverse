'use client';

import { useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { emailOtp } from '@/lib/auth-client';

export function VerifyOtpForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const email = searchParams.get('email') ?? '';
  const next = searchParams.get('next') ?? '/account';

  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleVerify(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const result = await emailOtp.signIn({ email, otp: code });

      if (result.error) {
        setError(result.error.message ?? 'Invalid code');
        return;
      }

      router.push(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }

  async function handleResend() {
    setLoading(true);
    await emailOtp.sendVerificationOtp({ email, type: 'sign-in' });
    setLoading(false);
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="text-center">
        <h2 className="text-lg font-semibold">Check your email</h2>
        <p className="mt-2 text-sm text-[var(--color-muted-foreground)]">
          We sent a 6-digit code to {email}
        </p>
      </div>

      <form onSubmit={handleVerify} className="flex flex-col gap-4">
        <input
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          required
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
          className="rounded-md border px-3 py-2 text-center text-2xl tracking-widest"
          placeholder="000000"
        />

        {error && (
          <p className="text-sm text-[var(--color-destructive)]">{error}</p>
        )}

        <button
          type="submit"
          disabled={loading || code.length !== 6}
          className="rounded-md bg-[var(--color-primary)] py-2 text-[var(--color-primary-foreground)] disabled:opacity-50"
        >
          {loading ? 'Verifying...' : 'Verify'}
        </button>

        <button
          type="button"
          onClick={handleResend}
          disabled={loading}
          className="text-sm text-[var(--color-muted-foreground)] hover:underline"
        >
          Didn't get a code? Resend
        </button>
      </form>
    </div>
  );
}
