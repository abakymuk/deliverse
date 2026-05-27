import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { getBrandContext, getStorefrontContext } from '@/lib/tenant-resolution';

/**
 * Auth route layout. Renders a centered card wrapper with the storefront
 * heading.
 *
 * DEL-25 PR 25b: dispatches on `storefrontType` instead of requiring
 * `x-brand-slug`. On tenant-host (food-hall mode 3) the layout renders
 * the storefront name as the heading; on brand-host (mode 1/2) it shows
 * the brand name + tenant subtitle. Without this, `/login`, `/signup`,
 * `/verify-otp`, etc. on a food-hall tenant-host would `notFound()`,
 * which breaks the add-to-cart auth-gate flow (anonymous → redirect to
 * `/login?next=<food-hall-path>` would 404 before 25b's fix).
 */
export default async function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const ctx = await getStorefrontContext();
  if (!ctx) notFound();

  let title: string;
  let subtitle: string | null = null;

  if (ctx.storefrontType === 'brand') {
    if (!ctx.brandSlug) notFound();
    const brandCtx = await getBrandContext(ctx.brandSlug);
    if (!brandCtx) notFound();
    title = brandCtx.brand.name;
    subtitle =
      ctx.tenantId === brandCtx.brand.tenantId
        ? `Part of ${brandCtx.tenant.name}`
        : null;
  } else {
    // tenant-host (food-hall). No brand context — use the storefront
    // name as the heading.
    const h = await headers();
    title = h.get('x-storefront-name') ?? 'Sign in';
  }

  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <h1 className="text-2xl font-bold">{title}</h1>
          {subtitle && (
            <p className="mt-2 text-xs text-[var(--color-muted-foreground)]">
              {subtitle}
            </p>
          )}
        </div>
        {children}
      </div>
    </div>
  );
}
