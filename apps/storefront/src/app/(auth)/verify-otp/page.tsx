import { notFound } from 'next/navigation';
import { Suspense } from 'react';
import { VerifyOtpForm } from '@/components/auth/verify-otp-form';
import { checkEmailExistsInTenant, hasUserVisitedBrand } from '@/lib/cross-brand';
import { getBrandContext, getStorefrontContext } from '@/lib/tenant-resolution';

/**
 * DEL-14: server-side cross-brand lookup feeds the welcome-back copy.
 *
 * Trigger condition: the email already has an account in this tenant AND the
 * user has never had a session at the current brand (i.e., they're crossing
 * brands for the first time on this device). See docs/specs/auth-ui.md §5e.
 *
 * The form stays a client component for `useForm`/`useSearchParams`; the
 * welcome-back props are server-derived and stable for this render.
 *
 * DEL-25 PR 25b: dispatch on storefrontType. On tenant-host (mode 3)
 * there's no current brand context, so the welcome-back disclosure
 * doesn't apply — render the form without brand props (the form
 * already guards `showWelcomeBack` on `!!brandName && !!tenantName`).
 */
export default async function VerifyOtpPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const ctx = await getStorefrontContext();
  if (!ctx) notFound();

  if (ctx.storefrontType === 'brand') {
    if (!ctx.brandSlug) notFound();
    const brandCtx = await getBrandContext(ctx.brandSlug);
    if (!brandCtx) notFound();

    const sp = await searchParams;
    const emailRaw = sp.email;
    const email = typeof emailRaw === 'string' ? emailRaw : '';

    let welcomeBack = false;
    if (email) {
      const [emailExists, visitedCurrentBrand] = await Promise.all([
        checkEmailExistsInTenant(brandCtx.tenant.id, email),
        hasUserVisitedBrand(brandCtx.tenant.id, email, brandCtx.brand.id),
      ]);
      welcomeBack = emailExists && !visitedCurrentBrand;
    }

    return (
      <div className="flex min-h-svh w-full items-center justify-center p-6 md:p-10">
        <div className="w-full max-w-sm">
          <Suspense fallback={null}>
            <VerifyOtpForm
              welcomeBack={welcomeBack}
              brandName={brandCtx.brand.name}
              tenantName={brandCtx.tenant.name}
            />
          </Suspense>
        </div>
      </div>
    );
  }

  // tenant-host (food-hall). No brand context → no welcome-back UI
  // (cross-brand recognition is brand-relative). Form renders the
  // generic "We've sent a code to your email." copy.
  return (
    <div className="flex min-h-svh w-full items-center justify-center p-6 md:p-10">
      <div className="w-full max-w-sm">
        <Suspense fallback={null}>
          <VerifyOtpForm />
        </Suspense>
      </div>
    </div>
  );
}
