import Link from 'next/link';
import { Card, CardContent, CardTitle } from '@rp/ui/components/card';
import type { BrandBranding } from '@rp/db';
import { brandThemeStyle } from '@/lib/brand-theme';

type BrandCardProps = {
  slug: string;
  name: string;
  branding: BrandBranding | null | undefined;
};

/**
 * RSC. Single brand tile in the food-hall directory. Links to the brand
 * subsection at `/b/<slug>`. Brand-themed accent applied via inline CSS
 * variable override on the link wrapper.
 *
 * DEL-25 / docs/specs/food-hall-storefront.md.
 */
export function BrandCard({ slug, name, branding }: BrandCardProps) {
  return (
    <Link
      href={`/b/${slug}`}
      className="block"
      style={brandThemeStyle(branding)}
    >
      <Card className="transition-colors hover:border-[var(--color-primary)]">
        <CardContent className="p-6">
          <CardTitle className="text-xl">{name}</CardTitle>
          <p className="mt-2 text-sm text-[var(--color-muted-foreground)]">
            Browse menu →
          </p>
        </CardContent>
      </Card>
    </Link>
  );
}
