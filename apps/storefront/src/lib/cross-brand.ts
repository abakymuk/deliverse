/**
 * Cross-brand helpers for the storefront — used by the signup page's disclosure
 * component to list sibling brands within the same tenant.
 *
 * Mirrors the shape of `packages/emails/src/brand-context.ts`'s Drizzle query
 * style (raw `db.select().from(brands).where(...)`) but doesn't share — this
 * helper has different where-clause semantics (sibling listing vs. specific
 * brand lookup) and lives in the storefront app, not the emails package.
 *
 * Per `docs/specs/auth-ui.md` §4 decision #1: the disclosure is always-on
 * (not conditional on email lookup) when there's at least one sibling brand,
 * so this helper only needs to enumerate sibling brands — no email-existence
 * check.
 */

import { type Brand, brands, db } from '@rp/db';
import { and, eq, isNull, ne } from 'drizzle-orm';

/**
 * Returns the active sibling brands within the same tenant, excluding the
 * caller's current brand. Empty array if the tenant has only one brand or
 * if all siblings are deleted/inactive.
 */
export async function getSiblingBrands(
  tenantId: string,
  currentBrandSlug: string,
): Promise<Brand[]> {
  return db
    .select()
    .from(brands)
    .where(
      and(
        eq(brands.tenantId, tenantId),
        ne(brands.slug, currentBrandSlug),
        isNull(brands.deletedAt),
        eq(brands.isActive, true),
      ),
    )
    .orderBy(brands.name);
}
