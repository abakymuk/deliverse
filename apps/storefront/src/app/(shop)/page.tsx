import { FoodHallStub } from '@/components/food-hall-stub';
import { getBrandContext } from '@/lib/tenant-resolution';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';

export default async function StorefrontHome() {
  const h = await headers();
  const storefrontType = h.get('x-storefront-type');

  if (storefrontType === 'brand') {
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

  if (storefrontType === 'tenant') {
    const storefrontName = h.get('x-storefront-name') ?? '';
    return <FoodHallStub storefrontName={storefrontName} />;
  }

  notFound();
}
