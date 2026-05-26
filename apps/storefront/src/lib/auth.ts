import { createStorefrontAuth } from '@rp/auth-core/storefront';
import { resolveStorefrontTenantContext } from './storefront-tenant-context';

export const auth = createStorefrontAuth(resolveStorefrontTenantContext);

export type Session = Awaited<ReturnType<typeof auth.api.getSession>>;
