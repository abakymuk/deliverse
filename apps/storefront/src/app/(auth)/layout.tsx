import { headers } from 'next/headers';
import { getBrandContext } from '@/lib/tenant-resolution';
import { notFound } from 'next/navigation';

export default async function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const h = await headers();
  const brandSlug = h.get('x-brand-slug');

  if (!brandSlug) {
    notFound();
  }

  const ctx = await getBrandContext(brandSlug);
  if (!ctx) {
    notFound();
  }

  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <h1 className="text-2xl font-bold">{ctx.brand.name}</h1>
          {ctx.tenant.id !== ctx.brand.tenantId ? null : (
            <p className="mt-2 text-xs text-[var(--color-muted-foreground)]">
              Part of {ctx.tenant.name}
            </p>
          )}
        </div>
        {children}
      </div>
    </div>
  );
}
