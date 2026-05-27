import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { Suspense } from 'react';
import { SignupForm } from '@/components/auth/signup-form';
import { CrossBrandDisclosure } from '@/components/brand/cross-brand-disclosure';
import { getSiblingBrands } from '@/lib/cross-brand';
import { getBrandContext, getStorefrontContext } from '@/lib/tenant-resolution';

export const metadata = {
  title: 'Sign up',
};

/**
 * Signup route.
 *
 * - Mode 1/2 (storefrontType='brand'): brand-themed signup card with the
 *   cross-brand "Part of {Tenant}'s family" disclosure when sibling
 *   brands exist.
 * - Mode 3 (storefrontType='tenant', food-hall): tenant-themed signup
 *   card. No cross-brand disclosure (there's no current brand to be a
 *   sibling of). DEL-25 PR 25b — required so the add-to-cart auth-gate
 *   path from a food-hall page lands on a working signup page.
 */
export default async function SignupPage() {
  const ctx = await getStorefrontContext();
  if (!ctx) notFound();

  if (ctx.storefrontType === 'brand') {
    if (!ctx.brandSlug) notFound();
    const brandCtx = await getBrandContext(ctx.brandSlug);
    if (!brandCtx) notFound();

    const siblingBrands = await getSiblingBrands(
      brandCtx.tenant.id,
      brandCtx.brand.slug,
    );

    return (
      <div className="flex min-h-svh w-full items-center justify-center p-6 md:p-10">
        <div className="w-full max-w-sm">
          <CrossBrandDisclosure
            brand={brandCtx.brand}
            tenant={brandCtx.tenant}
            siblingBrands={siblingBrands}
          />
          <Suspense fallback={null}>
            <SignupForm brand={brandCtx.brand} />
          </Suspense>
        </div>
      </div>
    );
  }

  // tenant-host (food-hall). No `brand` to pass; SignupForm renders a
  // tenant-themed "Create your {storefrontName} account" instead.
  const h = await headers();
  const storefrontName = h.get('x-storefront-name') ?? 'Account';

  return (
    <div className="flex min-h-svh w-full items-center justify-center p-6 md:p-10">
      <div className="w-full max-w-sm">
        <Suspense fallback={null}>
          <SignupForm storefrontName={storefrontName} />
        </Suspense>
      </div>
    </div>
  );
}
