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
export function extractBrandSlug(
  host: string | null | undefined,
  baseDomain: string | undefined,
): string | null {
  if (!host || !baseDomain) return null;

  const stripPort = (s: string) => s.toLowerCase().split(':')[0] ?? '';
  const h = stripPort(host);
  const b = stripPort(baseDomain);
  if (!h || !b) return null;

  if (h === b) return null;
  if (!h.endsWith(`.${b}`)) return null;

  const subdomain = h.slice(0, -(b.length + 1));
  const [brandSlug = ''] = subdomain.split('.');

  if (!brandSlug || RESERVED_SUBDOMAINS.has(brandSlug)) return null;
  return brandSlug;
}
