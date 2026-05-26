/**
 * Cases for storefront `deriveVerificationType`.
 *
 * Asserts the four BA 1.6.11 identifier conventions documented in
 * docs/specs/storefront-tenant-scoping.md §6, plus negative cases.
 * Run with `pnpm --filter @rp/auth-core exec tsx scratch/verification-type-check.ts`
 * (no env required).
 */

import assert from 'node:assert/strict';
import {
  type VerificationType,
  deriveVerificationType,
} from '../src/storefront-verification-type.ts';

const cases: {
  input: string | null | undefined;
  expected: VerificationType | null;
  label: string;
}[] = [
  {
    input: 'sign-in-otp-user@example.com',
    expected: 'otp_login',
    label: 'OTP sign-in identifier → otp_login',
  },
  {
    input: 'email-verification-otp-user@example.com',
    expected: 'email_verify',
    label: 'OTP email-verification identifier → email_verify',
  },
  {
    input: 'forget-password-otp-user@example.com',
    expected: 'password_reset',
    label: 'OTP forget-password identifier → password_reset',
  },
  {
    input: 'reset-password:abcdef1234567890',
    expected: 'password_reset',
    label: 'non-OTP password-reset identifier → password_reset',
  },
  {
    input: '',
    expected: null,
    label: 'empty identifier → null',
  },
  {
    input: null,
    expected: null,
    label: 'null identifier → null',
  },
  {
    input: 'unknown-prefix:foo',
    expected: null,
    label: 'unknown prefix → null',
  },
];

let failed = 0;
for (const c of cases) {
  const actual = deriveVerificationType(c.input);
  try {
    assert.equal(actual, c.expected);
    console.log(`✓ ${c.label}`);
  } catch {
    failed++;
    console.error(
      `✗ ${c.label}\n    input=${JSON.stringify(c.input)} expected=${c.expected} actual=${actual}`,
    );
  }
}

if (failed > 0) {
  console.error(`\n${failed} of ${cases.length} cases failed`);
  process.exit(1);
}
console.log(`\nAll ${cases.length} cases passed.`);
