/**
 * Pure helpers for storefront subdomain → brand-slug extraction.
 *
 * Lives in @rp/auth-core (not apps/storefront) so the adapter wrapper can
 * use it without an apps→packages dependency. The app's
 * `tenant-resolution.ts` re-exports `extractBrandSlug` for proxy / server
 * component callers.
 *
 * Spec: docs/specs/storefront-tenant-scoping.md §8.
 */

const RESERVED_SUBDOMAINS = new Set(['www', 'admin', 'api', 'app']);

/**
 * Extract the brand slug from a Host header value.
 *
 * Examples:
 *   extractBrandSlug('pizza-express.deliverse.app', 'deliverse.app') → 'pizza-express'
 *   extractBrandSlug('pizza-express.localhost:3001', 'localhost:3001') → 'pizza-express'
 *   extractBrandSlug('deliverse.app', 'deliverse.app') → null  (root, no brand)
 *   extractBrandSlug('admin.deliverse.app', 'deliverse.app') → null  (reserved)
 *   extractBrandSlug(null, 'deliverse.app') → null
 *
 * Port is stripped from both sides before comparison, matching the
 * `isAllowedStorefrontOrigin` helper in `storefront-origin.ts`.
 */
/**
 * Lowercase + strip optional `<scheme>://` prefix + strip optional `:port`
 * suffix. Tolerates both `localhost:3001` and `http://localhost:3001`
 * shapes for the env var (docs prescribe the former; the dev Doppler
 * config historically used the latter — defensive parsing keeps both
 * working without a Doppler edit).
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

export function extractBrandSlug(
  host: string | null | undefined,
  baseDomain: string | undefined,
): string | null {
  if (!host || !baseDomain) return null;

  const h = normalizeDomain(host);
  const b = normalizeDomain(baseDomain);
  if (!h || !b) return null;

  if (h === b) return null;
  if (!h.endsWith(`.${b}`)) return null;

  const subdomain = h.slice(0, -(b.length + 1));
  const [brandSlug = ''] = subdomain.split('.');

  if (!brandSlug || RESERVED_SUBDOMAINS.has(brandSlug)) return null;
  return brandSlug;
}
