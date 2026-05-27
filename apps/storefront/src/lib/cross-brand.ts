/**
 * Cross-brand helpers for the storefront.
 *
 * - `getSiblingBrands` (DEL-7): always-on signup-page disclosure listing
 *   sibling brands within the same tenant.
 * - `checkEmailExistsInTenant` + `hasUserVisitedBrand` (DEL-14): drive the
 *   verify-otp "Welcome back!" personalization when a user crosses brands
 *   within the same tenant for the first time. See docs/specs/auth-ui.md
 *   §5e DEL-14 extension + §7 for the trigger logic.
 *
 * Drizzle query style mirrors `packages/emails/src/brand-context.ts`.
 */

import { type Brand, brands, db, tenantEndUserSessions, tenantEndUsers } from '@rp/db';
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

/**
 * DEL-14: returns true iff the email already has an active (non-soft-deleted)
 * account at this tenant. Used by `verify-otp/page.tsx` to decide whether to
 * render the welcome-back copy.
 */
export async function checkEmailExistsInTenant(tenantId: string, email: string): Promise<boolean> {
  const rows = await db
    .select({ id: tenantEndUsers.id })
    .from(tenantEndUsers)
    .where(
      and(
        eq(tenantEndUsers.tenantId, tenantId),
        eq(tenantEndUsers.email, email),
        isNull(tenantEndUsers.deletedAt),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/**
 * DEL-14: returns true iff the (tenant, email) user has at least one prior
 * session at this specific brand. Combined with `checkEmailExistsInTenant`,
 * `welcomeBack = emailExists && !visitedCurrentBrand` — the user has an
 * account in this tenant but has never been at the brand they're on now.
 *
 * Single-query: inner-join sessions to user with the matching brand predicate
 * so we don't roundtrip just to get the user ID first. Sessions cascade-delete
 * with the user, so a stale row never lingers past account deletion.
 */
export async function hasUserVisitedBrand(
  tenantId: string,
  email: string,
  brandId: string,
): Promise<boolean> {
  const rows = await db
    .select({ id: tenantEndUserSessions.id })
    .from(tenantEndUserSessions)
    .innerJoin(tenantEndUsers, eq(tenantEndUsers.id, tenantEndUserSessions.tenantEndUserId))
    .where(
      and(
        eq(tenantEndUsers.tenantId, tenantId),
        eq(tenantEndUsers.email, email),
        isNull(tenantEndUsers.deletedAt),
        eq(tenantEndUserSessions.currentBrandId, brandId),
      ),
    )
    .limit(1);
  return rows.length > 0;
}
