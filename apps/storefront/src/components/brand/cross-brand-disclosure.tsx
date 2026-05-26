/**
 * Cross-brand disclosure — auth-spec §10 GDPR/trust copy.
 *
 * Renders only when the storefront brand has at least one active sibling
 * brand within the same tenant. Always-on (NOT conditional on email
 * lookup) per docs/specs/auth-ui.md §4 decision #1. Email-existence-based
 * "Welcome back!" personalization on the verify-otp page is deferred.
 *
 * Mounted by the storefront signup page above the form.
 */

import type { Brand, Tenant } from '@rp/db';

export type CrossBrandDisclosureProps = {
  brand: Brand;
  tenant: Tenant;
  siblingBrands: Brand[];
};

export function CrossBrandDisclosure({ brand, tenant, siblingBrands }: CrossBrandDisclosureProps) {
  if (siblingBrands.length === 0) return null;

  const siblingList = siblingBrands.map((b) => b.name).join(', ');

  return (
    <div className="mb-4 rounded-lg border border-[var(--color-border)] bg-[var(--color-muted)] p-4 text-sm">
      <p className="font-medium text-[var(--color-foreground)]">
        {brand.name} is part of {tenant.name}&apos;s family of brands ({siblingList}).
      </p>
      <p className="mt-1 text-[var(--color-muted-foreground)]">
        Your account works at all of them.
      </p>
    </div>
  );
}
