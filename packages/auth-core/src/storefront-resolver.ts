/**
 * Storefront resolver: maps a subdomain slug to a flat storefront context.
 *
 * Mirrors {@link resolveBrandBySlug} but queries the DEL-19 `storefronts`
 * table — the routing layer's source of truth per ADR-0012. The returned
 * shape is flat (UUID strings, no Drizzle row types) because the proxy
 * injects these as headers; consumers downstream of the proxy work in the
 * string-header domain.
 *
 * No React `cache()` — packages stay UI-framework-free per ADR-0009.
 *
 * Spec: docs/specs/storefront-host-resolution.md
 */

import { db, storefronts, tenants } from '@rp/db';
import { and, eq, isNull } from 'drizzle-orm';

export type StorefrontContext = {
  storefrontId: string;
  storefrontType: 'brand' | 'tenant';
  storefrontName: string;
  tenantId: string;
  /**
   * Present iff `storefrontType === 'brand'`. Maps from the DB column
   * `primary_brand_id`: NULL (`type='tenant'`) becomes `undefined`, never
   * `null` — keeps the public optional-property contract honest.
   */
  brandId?: string;
};

type StorefrontRow = {
  storefrontId: string;
  storefrontType: 'brand' | 'tenant';
  storefrontName: string;
  tenantId: string;
  primaryBrandId: string | null;
};

/**
 * Pure row-to-context mapper. Exported for unit tests so we can verify
 * `primaryBrandId: null` → `brandId: undefined` without deep-mocking
 * the Drizzle fluent chain. The actual DB query behavior (filters, joins)
 * is covered by e2e.
 */
export function rowToStorefrontContext(row: StorefrontRow): StorefrontContext {
  return {
    storefrontId: row.storefrontId,
    storefrontType: row.storefrontType,
    storefrontName: row.storefrontName,
    tenantId: row.tenantId,
    brandId: row.primaryBrandId ?? undefined,
  };
}

export async function resolveStorefrontBySlug(
  slug: string,
): Promise<StorefrontContext | null> {
  const result = await db
    .select({
      storefrontId: storefronts.id,
      storefrontType: storefronts.type,
      storefrontName: storefronts.name,
      tenantId: storefronts.tenantId,
      primaryBrandId: storefronts.primaryBrandId,
    })
    .from(storefronts)
    .innerJoin(tenants, eq(storefronts.tenantId, tenants.id))
    .where(
      and(
        eq(storefronts.slug, slug),
        isNull(storefronts.deletedAt),
        eq(storefronts.isActive, true),
        isNull(tenants.deletedAt),
        eq(tenants.status, 'active'),
      ),
    )
    .limit(1);

  const row = result[0];
  return row ? rowToStorefrontContext(row) : null;
}

/**
 * Conservative UUID v4-ish regex. We don't enforce the version nibble — only
 * the canonical 8-4-4-4-12 hex shape with hyphens. The point is to reject
 * obvious garbage (empty strings, slugs, random tokens) BEFORE hitting the
 * DB, so we don't pollute the connection pool with `invalid input syntax for
 * type uuid` errors on every malformed request.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resolve a storefront context from its row UUID, alongside the storefront
 * slug (which the caller doesn't have in this code path).
 *
 * Used by the storefront tenant-context resolver's source-#1 lookup
 * (`x-storefront-id` header, proxy-injected). See
 * `docs/specs/cookie-cache-tenant-version.md` AC#3.
 *
 * Same active+non-deleted predicates as {@link resolveStorefrontBySlug} —
 * one source of truth for "the storefront row is currently usable."
 *
 * Returns null for any non-UUID input (without a DB roundtrip) and for any
 * UUID that doesn't match an active, non-deleted storefront under an active,
 * non-deleted tenant.
 */
export async function resolveStorefrontById(
  id: string,
): Promise<(StorefrontContext & { slug: string }) | null> {
  if (!UUID_RE.test(id)) return null;

  const result = await db
    .select({
      storefrontId: storefronts.id,
      storefrontType: storefronts.type,
      storefrontName: storefronts.name,
      tenantId: storefronts.tenantId,
      primaryBrandId: storefronts.primaryBrandId,
      slug: storefronts.slug,
    })
    .from(storefronts)
    .innerJoin(tenants, eq(storefronts.tenantId, tenants.id))
    .where(
      and(
        eq(storefronts.id, id),
        isNull(storefronts.deletedAt),
        eq(storefronts.isActive, true),
        isNull(tenants.deletedAt),
        eq(tenants.status, 'active'),
      ),
    )
    .limit(1);

  const row = result[0];
  if (!row) return null;
  return { ...rowToStorefrontContext(row), slug: row.slug };
}
