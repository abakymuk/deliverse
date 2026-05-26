/**
 * Tests for the Resend client wrapper's lazy-init env-check behavior.
 *
 * `next build` evaluates the App Router route graph with NODE_ENV=production
 * — if the env check ran at module load, the build would fail whenever
 * RESEND_API_KEY isn't in the build environment (which is by design —
 * the key only needs to be present at request time on the deployed server).
 * The wrapper defers env validation to first `sendEmail` call instead.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('client module', () => {
  it('does not throw at module load when NODE_ENV=production and RESEND_API_KEY is missing', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('RESEND_API_KEY', '');
    vi.stubEnv('RESEND_FROM_EMAIL', '');

    // Should not throw. (Bug caught during `next build` — the prior
    // module-load env check would fail this assertion.)
    await expect(import('../src/client')).resolves.toBeDefined();
  });

  it('throws on first sendEmail call when NODE_ENV=production and RESEND_API_KEY is missing', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('RESEND_API_KEY', '');
    vi.stubEnv('RESEND_FROM_EMAIL', '');

    const { sendEmail } = await import('../src/client');
    await expect(
      sendEmail({ to: 't@example.com', subject: 's', react: null as never }),
    ).rejects.toThrow(/RESEND_API_KEY is required/);
  });

  it('no-ops in non-production when RESEND_API_KEY is missing', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('RESEND_API_KEY', '');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { sendEmail } = await import('../src/client');
    const result = await sendEmail({
      to: 't@example.com',
      subject: 'Your sign-in code for Pizza Express',
      react: null as never,
    });

    expect(result).toEqual({ id: 'dev-noop' });
    expect(warn).toHaveBeenCalledOnce();
    const logLine = warn.mock.calls[0]?.[0] as string;
    expect(logLine).toContain('[DEV] would send');
    expect(logLine).toContain('t@example.com');
    expect(logLine).toContain('Pizza Express');
    // OTP-leak prevention: no body / preview in the log line.
    expect(logLine).not.toMatch(/\d{6}/);
  });
});
