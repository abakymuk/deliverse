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
/**
 * Lowercase + strip optional `<scheme>://` prefix + strip optional `:port`
 * suffix. Matches `storefront-host.ts:normalizeDomain` — defensive parsing
 * for `NEXT_PUBLIC_STOREFRONT_BASE_DOMAIN` that may be set as either
 * `localhost:3001` (docs) or `http://localhost:3001` (some Doppler configs).
 */
function normalizeDomain(s: string): string {
  let v = s.toLowerCase();
  const schemeIdx = v.indexOf('://');
  if (schemeIdx >= 0) v = v.slice(schemeIdx + 3);
  const portIdx = v.indexOf(':');
  if (portIdx >= 0) v = v.slice(0, portIdx);
  const slashIdx = v.indexOf('/');
  if (slashIdx >= 0) v = v.slice(0, slashIdx);
  return v;
}

export function isAllowedStorefrontOrigin(
  host: string | null | undefined,
  baseDomain: string | undefined,
): boolean {
  if (!host || !baseDomain) return false;
  const h = normalizeDomain(host);
  const b = normalizeDomain(baseDomain);
  if (!h || !b) return false;
  return h === b || h.endsWith(`.${b}`);
}
