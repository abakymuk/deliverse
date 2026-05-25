/**
 * Pure helper for storefront `trustedOrigins` boundary check.
 *
 * Extracted into its own zero-dependency module so it can be exercised by a
 * scratch script without pulling in better-auth or @rp/db. Re-exported from
 * storefront.ts.
 *
 * Spec: docs/specs/better-auth-config-v1.md §8.7.
 */

/**
 * Does `host` belong to the configured storefront base domain?
 *
 * Normalizes case + strips port from both sides so `pizza-express.localhost:3001`
 * and `PIZZA-EXPRESS.localhost` both compare cleanly against `localhost`.
 *
 * The leading `.` in the suffix check prevents `evildeliverse.app` from
 * matching `deliverse.app` (which a naive `endsWith` would allow).
 */
export function isAllowedStorefrontOrigin(
  host: string | null | undefined,
  baseDomain: string | undefined,
): boolean {
  if (!host || !baseDomain) return false;
  const normalize = (s: string) => s.toLowerCase().split(':')[0];
  const h = normalize(host);
  const b = normalize(baseDomain);
  if (!h || !b) return false;
  return h === b || h.endsWith('.' + b);
}
