import { SignupForm } from '@/components/auth/signup-form';
import { CrossBrandDisclosure } from '@/components/brand/cross-brand-disclosure';
import { getSiblingBrands } from '@/lib/cross-brand';
import { getBrandContext } from '@/lib/tenant-resolution';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { Suspense } from 'react';

export const metadata = {
  title: 'Sign up',
};

export default async function SignupPage() {
  const h = await headers();
  const brandSlug = h.get('x-brand-slug');
  if (!brandSlug) notFound();

  const ctx = await getBrandContext(brandSlug);
  if (!ctx) notFound();

  const siblingBrands = await getSiblingBrands(ctx.tenant.id, ctx.brand.slug);

  return (
    <div className="flex min-h-svh w-full items-center justify-center p-6 md:p-10">
      <div className="w-full max-w-sm">
        <CrossBrandDisclosure brand={ctx.brand} tenant={ctx.tenant} siblingBrands={siblingBrands} />
        <Suspense fallback={null}>
          <SignupForm brand={ctx.brand} />
        </Suspense>
      </div>
    </div>
  );
}
