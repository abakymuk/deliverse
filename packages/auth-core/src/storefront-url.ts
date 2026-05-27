/**
 * Rewrites the origin of a Better-Auth-constructed storefront email URL so
 * it points at the brand subdomain the user came from instead of the
 * platform host that BA picked up from `BETTER_AUTH_URL`.
 *
 * Spec: docs/specs/del-15-storefront-baseurl.md.
 *
 * Why this exists: BA 1.6.11 freezes `ctx.context.baseURL` at init time
 * from `process.env.BETTER_AUTH_URL` (= platform's URL in Doppler) and the
 * reset-password route uses that static value
 * (node_modules/better-auth/dist/api/routes/password.mjs:72). The storefront
 * BA instance is multi-tenant, so a static `baseURL` is structurally wrong.
 * We post-process the URL in the `sendResetPassword` callback instead.
 *
 * The storefront host is reconstructed as `${storefrontSlug}.${baseDomain}`.
 * The storefrontSlug comes from `resolveStorefrontTenantContext` (already
 * derived from `Host` upstream — it's the matched subdomain regardless of
 * whether the storefront is brand-type or tenant-type per ADR-0012) and
 * `baseDomain` from `NEXT_PUBLIC_STOREFRONT_BASE_DOMAIN` (already used by
 * `trustedOrigins` in the same BA config). No `next/headers` import in this
 * package — keeps @rp/auth-core UI-framework-free per ADR-0009.
 *
 * DEL-22 renamed `brandSlug` → `storefrontSlug` (same logic; semantic shift).
 */

/**
 * Strip optional `<scheme>://` prefix and trailing path off the env value.
 * Keeps the port — `localhost:3001` is the dev value and must survive.
 *
 * Mirrors the scheme-tolerant parsing in `storefront-host.ts:normalizeDomain`
 * (which strips port for slug comparison); this variant keeps port for URL
 * composition. The tolerance is intentional defense against the Doppler dev
 * config historically using `http://localhost:3001` as the env value.
 */
function normalizeBaseDomainForUrl(s: string): string {
  let v = s.trim().toLowerCase();
  const schemeIdx = v.indexOf('://');
  if (schemeIdx >= 0) v = v.slice(schemeIdx + 3);
  const slashIdx = v.indexOf('/');
  if (slashIdx >= 0) v = v.slice(0, slashIdx);
  return v;
}

export type RewriteStorefrontEmailUrlInput = {
  /** BA-constructed URL (origin currently points at platform host). */
  originalUrl: string;
  /** Storefront subdomain slug, e.g. 'pizza-express' or 'oomi-kitchen-test'.
   * From `resolveStorefrontTenantContext`. DEL-22: same slug regardless of
   * `storefrontType` ('brand' or 'tenant'); the slug IS the subdomain. */
  storefrontSlug: string;
  /** Value of `NEXT_PUBLIC_STOREFRONT_BASE_DOMAIN`. May include scheme prefix. */
  baseDomain: string;
  /** 'https' in stg/prd, 'http' in dev. Match `trustedOrigins` derivation. */
  proto: 'http' | 'https';
};

export function rewriteStorefrontEmailUrl(input: RewriteStorefrontEmailUrlInput): string {
  const { originalUrl, storefrontSlug, baseDomain, proto } = input;
  const normalizedBaseDomain = normalizeBaseDomainForUrl(baseDomain);
  const u = new URL(originalUrl);
  u.protocol = `${proto}:`;
  u.host = `${storefrontSlug}.${normalizedBaseDomain}`;
  return u.toString();
}
