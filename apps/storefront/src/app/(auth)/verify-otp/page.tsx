import { VerifyOtpForm } from '@/components/auth/verify-otp-form';
import { checkEmailExistsInTenant, hasUserVisitedBrand } from '@/lib/cross-brand';
import { getBrandContext } from '@/lib/tenant-resolution';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { Suspense } from 'react';

/**
 * DEL-14: server-side cross-brand lookup feeds the welcome-back copy.
 *
 * Trigger condition: the email already has an account in this tenant AND the
 * user has never had a session at the current brand (i.e., they're crossing
 * brands for the first time on this device). See docs/specs/auth-ui.md §5e.
 *
 * The form stays a client component for `useForm`/`useSearchParams`; the
 * welcome-back props are server-derived and stable for this render.
 */
export default async function VerifyOtpPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const h = await headers();
  const brandSlug = h.get('x-brand-slug');
  if (!brandSlug) notFound();

  const ctx = await getBrandContext(brandSlug);
  if (!ctx) notFound();

  const sp = await searchParams;
  const emailRaw = sp.email;
  const email = typeof emailRaw === 'string' ? emailRaw : '';

  let welcomeBack = false;
  if (email) {
    const [emailExists, visitedCurrentBrand] = await Promise.all([
      checkEmailExistsInTenant(ctx.tenant.id, email),
      hasUserVisitedBrand(ctx.tenant.id, email, ctx.brand.id),
    ]);
    welcomeBack = emailExists && !visitedCurrentBrand;
  }

  return (
    <div className="flex min-h-svh w-full items-center justify-center p-6 md:p-10">
      <div className="w-full max-w-sm">
        <Suspense fallback={null}>
          <VerifyOtpForm
            welcomeBack={welcomeBack}
            brandName={ctx.brand.name}
            tenantName={ctx.tenant.name}
          />
        </Suspense>
      </div>
    </div>
  );
}
