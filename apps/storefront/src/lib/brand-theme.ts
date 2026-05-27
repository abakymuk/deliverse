import type { CSSProperties } from 'react';
import type { BrandBranding } from '@rp/db';

/**
 * Builds inline CSS custom-property overrides for a brand's theme.
 *
 * Tailwind v4's `@theme` block (packages/ui/src/styles/globals.css) defines
 * `--color-primary`, `--color-secondary`, etc. on `:root`. Setting the same
 * variables on a descendant element via inline `style` overrides them for
 * that subtree, so `bg-primary` / `text-primary` / `ring-primary` utilities
 * read the brand-specific value automatically. No theming provider library
 * needed.
 *
 * Empty / missing branding returns `{}` so the tenant defaults bleed through
 * — the food-hall shell renders with the platform's default theme, and each
 * brand subsection injects its own accent.
 *
 * Usage:
 *   <div style={brandThemeStyle(brand.brandingJson)}>...</div>
 *
 * DEL-25 / docs/specs/food-hall-storefront.md.
 */
export function brandThemeStyle(
  branding: BrandBranding | null | undefined,
): CSSProperties {
  if (!branding) return {};
  const style: Record<string, string> = {};
  if (branding.primary) style['--color-primary'] = branding.primary;
  if (branding.secondary) style['--color-secondary'] = branding.secondary;
  return style as CSSProperties;
}
