/**
 * @rp/auth-core — shared auth utilities and types
 *
 * Apps import the specific instance they need:
 *   import { platformAuth } from '@rp/auth-core/platform';
 *   import { storefrontAuth } from '@rp/auth-core/storefront';
 */

export type { PlatformAuth, PlatformSession } from './platform';
export type { StorefrontAuth, StorefrontSession } from './storefront';
