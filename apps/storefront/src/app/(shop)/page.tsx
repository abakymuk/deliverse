import { headers } from 'next/headers';
import { getBrandContext } from '@/lib/tenant-resolution';
import { notFound } from 'next/navigation';

export default async function StorefrontHome() {
  const h = await headers();
  const brandSlug = h.get('x-brand-slug');

  if (!brandSlug) notFound();
  const ctx = await getBrandContext(brandSlug);
  if (!ctx) notFound();

  return (
    <div className="container mx-auto p-8">
      <h1 className="text-4xl font-bold">{ctx.brand.name}</h1>
      <p className="mt-2 text-[var(--color-muted-foreground)]">
        Welcome. Sign in to start ordering.
      </p>
    </div>
  );
}
