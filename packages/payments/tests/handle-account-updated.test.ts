/**
 * handleAccountUpdated integration test (DEL-35 / X4 step 2).
 *
 * Requires DATABASE_URL:
 *   doppler run --config dev -- pnpm --filter @rp/payments test
 * Skipped otherwise — @rp/db throws at module-init without it, so @rp/db and
 * handlers.ts (which imports @rp/db) are loaded via DYNAMIC import inside the
 * gated block. PermanentWebhookError comes from a client-free module, so it's a
 * safe static import. The `stripe` import is type-only (erased at runtime).
 *
 * Proves:
 *   1. account.updated flips tenants.stripe_charges_enabled, resolving the
 *      tenant via metadata.tenant_id.
 *   2. resolution falls back to stripe_account_id when metadata is absent.
 *   3. an unresolvable account raises PermanentWebhookError (→ route ACKs 200).
 */

import { randomUUID } from 'node:crypto';
import type Stripe from 'stripe';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PermanentWebhookError } from '../src/errors';

const HAS_DB = !!process.env.DATABASE_URL;

type DbModule = typeof import('@rp/db');
type SchemaModule = typeof import('@rp/db/schema');
type HandlersModule = typeof import('../src/handlers');

let dbModule: DbModule;
let schemaModule: SchemaModule;
let handlersModule: HandlersModule;

let tenantId: string;
const ACCOUNT_ID = 'acct_test_del35';

// Minimal Stripe.Account — only the fields handleAccountUpdated reads.
function makeAccount(args: {
  id: string;
  charges_enabled: boolean;
  metadata?: Record<string, string>;
}): Stripe.Account {
  return {
    id: args.id,
    object: 'account',
    charges_enabled: args.charges_enabled,
    metadata: args.metadata ?? {},
  } as Stripe.Account;
}

describe.skipIf(!HAS_DB)('handleAccountUpdated', () => {
  beforeAll(async () => {
    dbModule = await import('@rp/db');
    schemaModule = await import('@rp/db/schema');
    handlersModule = await import('../src/handlers');

    tenantId = randomUUID();
    await dbModule.db.insert(schemaModule.tenants).values({
      id: tenantId,
      slug: `pay-test-${tenantId.slice(0, 8)}`,
      name: 'Payments Test Tenant',
      stripeAccountId: ACCOUNT_ID,
    });
  });

  afterAll(async () => {
    if (!tenantId) return;
    const { eq } = await import('drizzle-orm');
    await dbModule.db
      .delete(schemaModule.tenants)
      .where(eq(schemaModule.tenants.id, tenantId));
  });

  it('flips stripe_charges_enabled, resolving the tenant by metadata.tenant_id', async () => {
    const { db } = dbModule;
    const { tenants } = schemaModule;
    const { eq } = await import('drizzle-orm');

    await db.transaction((tx) =>
      handlersModule.handleAccountUpdated(
        tx,
        makeAccount({ id: ACCOUNT_ID, charges_enabled: true, metadata: { tenant_id: tenantId } }),
      ),
    );

    const [row] = await db
      .select({ enabled: tenants.stripeChargesEnabled })
      .from(tenants)
      .where(eq(tenants.id, tenantId));
    expect(row?.enabled).toBe(true);
  });

  it('falls back to stripe_account_id when metadata is absent', async () => {
    const { db } = dbModule;
    const { tenants } = schemaModule;
    const { eq } = await import('drizzle-orm');

    await db.update(tenants).set({ stripeChargesEnabled: false }).where(eq(tenants.id, tenantId));

    await db.transaction((tx) =>
      handlersModule.handleAccountUpdated(
        tx,
        makeAccount({ id: ACCOUNT_ID, charges_enabled: true }),
      ),
    );

    const [row] = await db
      .select({ enabled: tenants.stripeChargesEnabled })
      .from(tenants)
      .where(eq(tenants.id, tenantId));
    expect(row?.enabled).toBe(true);
  });

  it('throws PermanentWebhookError for an unresolvable account', async () => {
    const { db } = dbModule;
    await expect(
      db.transaction((tx) =>
        handlersModule.handleAccountUpdated(
          tx,
          makeAccount({ id: 'acct_does_not_exist', charges_enabled: true }),
        ),
      ),
    ).rejects.toBeInstanceOf(PermanentWebhookError);
  });
});
