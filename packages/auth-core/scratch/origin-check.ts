/**
 * Origin boundary check for the storefront's `trustedOrigins` helper.
 *
 * Asserts the seven cases listed in docs/specs/better-auth-config-v1.md §11.
 * Run with `pnpm --filter @rp/auth-core exec tsx scratch/origin-check.ts`
 * (no env required).
 */

import assert from 'node:assert/strict';
import { isAllowedStorefrontOrigin } from '../src/storefront-origin.ts';

const cases: {
  args: [string | null | undefined, string | undefined];
  expected: boolean;
  label: string;
}[] = [
  {
    args: ['pizza-express.deliverse.app', 'deliverse.app'],
    expected: true,
    label: 'subdomain of base domain → allowed',
  },
  {
    args: ['deliverse.app', 'deliverse.app'],
    expected: true,
    label: 'exact base domain → allowed',
  },
  {
    args: ['evildeliverse.app', 'deliverse.app'],
    expected: false,
    label: 'evil prefix without `.` boundary → rejected',
  },
  {
    args: ['pizza-express.localhost:3001', 'localhost'],
    expected: true,
    label: 'dev subdomain with port → allowed (port stripped before compare)',
  },
  {
    args: ['PIZZA.LOCALHOST', 'localhost'],
    expected: true,
    label: 'uppercase host → allowed (lowercased before compare)',
  },
  {
    args: [null, 'deliverse.app'],
    expected: false,
    label: 'null host → rejected',
  },
  {
    args: ['x.deliverse.app', undefined],
    expected: false,
    label: 'missing base domain env → rejected',
  },
  {
    args: ['pizza-express.localhost:3001', 'http://localhost:3001'],
    expected: true,
    label: 'base domain with scheme + port → allowed (scheme stripped)',
  },
  {
    args: ['pizza-express.deliverse.app', 'https://deliverse.app'],
    expected: true,
    label: 'base domain with https scheme → allowed',
  },
];

let failed = 0;
for (const c of cases) {
  const actual = isAllowedStorefrontOrigin(...c.args);
  try {
    assert.equal(actual, c.expected);
    console.log(`✓ ${c.label}`);
  } catch {
    failed++;
    console.error(
      `✗ ${c.label}\n    args=${JSON.stringify(c.args)} expected=${c.expected} actual=${actual}`,
    );
  }
}

if (failed > 0) {
  console.error(`\n${failed} of ${cases.length} cases failed`);
  process.exit(1);
}
console.log(`\nAll ${cases.length} cases passed.`);
