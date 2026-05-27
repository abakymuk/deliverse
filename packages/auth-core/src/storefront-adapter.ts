/**
 * Storefront tenant-scoped Drizzle adapter wrapper.
 *
 * Wraps a Better-Auth `DBAdapter` so that:
 *   - `create` for user/session/verification stamps tenant context
 *     onto the data
 *   - read + mutation methods for user/verification append a
 *     `tenantId = ctx.tenantId` predicate to the `where` clause
 *   - session lookups by `token` and the `account` model pass through
 *
 * The transaction method wraps the trx adapter recursively so operations
 * inside `runWithTransaction` (e.g. BA's `createOAuthUser`) stay scoped.
 *
 * Spec: docs/specs/storefront-tenant-scoping.md §5.
 * ADR: docs/decisions/0010-tenant-scoping-injection.md.
 *
 * The caller-supplied `resolveTenantContext` is called once per wrapped
 * method invocation. It is responsible for its own typed error throwing
 * (APIError on missing brand subdomain etc); the wrapper just propagates.
 */

import { APIError, type DBAdapter, type DBTransactionAdapter, type Where } from 'better-auth';
import {
  OTP_MAX_FAILURES,
  checkOtpRequest,
  extractEmailFromOtpIdentifier,
  normalizeOtpEmail,
  parseOtpAttemptsFromValue,
  recordOtpFailure,
  recordOtpThrottle,
} from './rate-limit';
import { deriveVerificationType } from './storefront-verification-type';

export type StorefrontTenantContext = {
  tenantId: string;
  /**
   * Storefront row UUID (DEL-22). Always present. Identifies the matched
   * `storefronts` row regardless of brand vs tenant type per ADR-0012.
   */
  storefrontId: string;
  /**
   * Storefront type discriminator (DEL-22). 'brand' for traditional brand
   * subdomains (storefront 1:1 with a brand); 'tenant' for food-hall
   * storefronts where one storefront curates multiple brands. ADR-0012.
   */
  storefrontType: 'brand' | 'tenant';
  /**
   * Subdomain we matched on `Host`. Always present. For `storefrontType==='brand'`
   * this equals `brandSlug` (DEL-19 backfill made `storefronts.slug === brands.slug`
   * for brand-type storefronts). For `storefrontType==='tenant'` this is the
   * food-hall slug (e.g., 'oomi-kitchen').
   */
  storefrontSlug: string;
  /**
   * Brand UUID when the host resolved to `storefrontType='brand'`; `undefined`
   * for tenant-mode (food-hall) sessions per ADR-0012.
   */
  brandId?: string;
  /**
   * Brand subdomain slug, e.g. 'pizza-express'. Present iff
   * `storefrontType === 'brand'`; identical to `storefrontSlug` in that mode.
   * Added in DEL-5 so the storefront OTP callback can compose Inngest event
   * payloads without a second DB lookup. The adapter wrapper itself does NOT
   * read this field — it scopes writes by `tenantId`/`brandId` only.
   * Consumer-only.
   */
  brandSlug?: string;
};

export type ResolveTenantContext = () => Promise<StorefrontTenantContext>;

const SCOPED_MODELS = new Set(['user', 'verification', 'account']);

function tenantPredicate(tenantId: string): Where {
  return {
    field: 'tenantId',
    value: tenantId,
    operator: 'eq',
    connector: 'AND',
  };
}

function withTenantWhere(where: Where[] | undefined, tenantId: string): Where[] {
  return where ? [...where, tenantPredicate(tenantId)] : [tenantPredicate(tenantId)];
}

function wrapMethods(
  inner: DBTransactionAdapter,
  resolveTenantContext: ResolveTenantContext,
): DBTransactionAdapter {
  return {
    id: inner.id,

    async create({ model, data, select, forceAllowId }) {
      if (model === 'user') {
        const ctx = await resolveTenantContext();
        return inner.create({
          model,
          data: { ...data, tenantId: ctx.tenantId },
          select,
          forceAllowId,
        });
      }
      if (model === 'session') {
        const ctx = await resolveTenantContext();
        // DEL-21: stamp UUID for brand-mode sessions; explicit NULL for
        // tenant-mode (food-hall) sessions. The `?? null` is explicit by
        // design — relying on Drizzle's undefined-omission behavior would
        // produce ambiguous SQL and silently regress if a future maintainer
        // restructures the spread. The branch where `ctx.brandId` is undefined
        // is unreachable in production until DEL-22 flips the resolver.
        return inner.create({
          model,
          data: { ...data, currentBrandId: ctx.brandId ?? null },
          select,
          forceAllowId,
        });
      }
      if (model === 'verification') {
        const ctx = await resolveTenantContext();
        const identifier = (data as { identifier?: string }).identifier;
        const type = deriveVerificationType(identifier);
        if (!type) {
          throw new APIError('BAD_REQUEST', {
            message: `unknown verification identifier shape — cannot derive verification.type (identifier=${identifier ?? '<missing>'})`,
            code: 'UNKNOWN_VERIFICATION_TYPE',
          });
        }
        // DEL-9: rate-limit OTP requests at the wrapped-adapter boundary
        // so the check sees fully-stamped tenant context (ADR-0010 §5.1).
        // Runs BEFORE inner.create so existing lockouts reject early.
        // POST-create, stamps a 60s "too_frequent" lockout that survives
        // BA's resolveOTP delete-then-retry catch path (routes.mjs:43-49).
        // Spec: docs/specs/otp-rate-limiting.md §"BA Behavior".
        let normalizedEmail: string | null = null;
        if (type === 'otp_login' && identifier) {
          const rawEmail = extractEmailFromOtpIdentifier(identifier);
          if (rawEmail) {
            normalizedEmail = normalizeOtpEmail(rawEmail);
            await checkOtpRequest({ tenantId: ctx.tenantId, email: rawEmail });
          }
          // If we couldn't extract an email, fall through — let inner.create
          // proceed unthrottled rather than block on a malformed identifier.
        }

        const createPromise = inner.create({
          model,
          data: {
            ...data,
            tenantId: ctx.tenantId,
            // DEL-22: stamp brand_id only when brand context present
            // (mirrors session-create's `?? null` pattern from DEL-21).
            // Tenant-host verifications get NULL. Email-branding fallback
            // (storefront.brandingJson, tenant.name/logo) lives in @rp/emails.
            brandId: ctx.brandId ?? null,
            type,
          },
          select,
          forceAllowId,
        });

        if (normalizedEmail) {
          const ne = normalizedEmail;
          // Fire-and-forget: stamp the 60s lockout only if inner.create
          // resolved (don't block on a failed write). Errors logged but
          // not propagated — would otherwise turn a successful OTP send
          // into a 500.
          void createPromise.then(
            () =>
              recordOtpThrottle({ tenantId: ctx.tenantId, identifier: ne }).catch(
                (err) => {
                  console.error('[DEL-9] recordOtpThrottle failed', err);
                },
              ),
            () => {
              /* create rejected; no throttle to record */
            },
          );
        }

        // Cast through `as never`: the const intermediate above loses
        // BA's `<T, R = T>` generic binding. The runtime value is exactly
        // what `return inner.create({...})` would yield in the other
        // branches; this assertion just papers over the inference gap.
        return createPromise as never;
      }
      if (model === 'account') {
        // DEL-12: stamps `tenantId` on the credential or OAuth account row.
        // Together with the schema migration (composite unique on
        // (tenant_id, provider_id, account_id)) this lets the same Google
        // account ID link to two independent tenant_end_users across tenants.
        // Requires `account.additionalFields.tenantId` in storefront.ts BA
        // config — without it the factory's transformInput drops the field.
        const ctx = await resolveTenantContext();
        return inner.create({
          model,
          data: { ...data, tenantId: ctx.tenantId },
          select,
          forceAllowId,
        });
      }
      return inner.create({ model, data, select, forceAllowId });
    },

    async findOne({ model, where, select, join }) {
      if (SCOPED_MODELS.has(model)) {
        const ctx = await resolveTenantContext();
        return inner.findOne({
          model,
          where: withTenantWhere(where, ctx.tenantId),
          select,
          join,
        });
      }
      return inner.findOne({ model, where, select, join });
    },

    async findMany({ model, where, limit, select, sortBy, offset, join }) {
      if (SCOPED_MODELS.has(model)) {
        const ctx = await resolveTenantContext();
        return inner.findMany({
          model,
          where: withTenantWhere(where, ctx.tenantId),
          limit,
          select,
          sortBy,
          offset,
          join,
        });
      }
      return inner.findMany({
        model,
        where,
        limit,
        select,
        sortBy,
        offset,
        join,
      });
    },

    async count({ model, where }) {
      if (SCOPED_MODELS.has(model)) {
        const ctx = await resolveTenantContext();
        return inner.count({ model, where: withTenantWhere(where, ctx.tenantId) });
      }
      return inner.count({ model, where });
    },

    async update({ model, where, update }) {
      if (SCOPED_MODELS.has(model)) {
        const ctx = await resolveTenantContext();

        // DEL-9: detect BA's failed-OTP attempt counter crossing
        // OTP_MAX_FAILURES and stamp a tenant_otp_lockouts row BEFORE BA's
        // next request deletes the verification (email-otp/routes.mjs:245-247).
        // We pull the identifier from the WHERE clause rather than the update
        // result — that avoids serializing the inner.update call and lets us
        // preserve its generic return type. Fire-and-forget: recordOtpFailure
        // runs in parallel with the inner.update and must not block BA's
        // response on a lockout-write failure (spec §Edge Cases #8).
        if (model === 'verification') {
          const updatedValue = (update as { value?: string }).value;
          if (typeof updatedValue === 'string') {
            const attempts = parseOtpAttemptsFromValue(updatedValue);
            if (attempts >= OTP_MAX_FAILURES) {
              const identifier = where?.find(
                (w): w is typeof w & { value: string } =>
                  w.field === 'identifier' && typeof w.value === 'string',
              )?.value;
              if (identifier?.startsWith('sign-in-otp-')) {
                const rawEmail = extractEmailFromOtpIdentifier(identifier);
                if (rawEmail) {
                  void recordOtpFailure({
                    tenantId: ctx.tenantId,
                    identifier: normalizeOtpEmail(rawEmail),
                  }).catch((err) => {
                    console.error('[DEL-9] recordOtpFailure failed', err);
                  });
                }
              }
            }
          }
        }

        return inner.update({
          model,
          where: withTenantWhere(where, ctx.tenantId),
          update,
        });
      }
      return inner.update({ model, where, update });
    },

    async updateMany({ model, where, update }) {
      if (SCOPED_MODELS.has(model)) {
        const ctx = await resolveTenantContext();
        return inner.updateMany({
          model,
          where: withTenantWhere(where, ctx.tenantId),
          update,
        });
      }
      return inner.updateMany({ model, where, update });
    },

    async delete({ model, where }) {
      if (SCOPED_MODELS.has(model)) {
        const ctx = await resolveTenantContext();
        return inner.delete({ model, where: withTenantWhere(where, ctx.tenantId) });
      }
      return inner.delete({ model, where });
    },

    async deleteMany({ model, where }) {
      if (SCOPED_MODELS.has(model)) {
        const ctx = await resolveTenantContext();
        return inner.deleteMany({
          model,
          where: withTenantWhere(where, ctx.tenantId),
        });
      }
      return inner.deleteMany({ model, where });
    },

    async consumeOne({ model, where }) {
      if (SCOPED_MODELS.has(model)) {
        const ctx = await resolveTenantContext();
        return inner.consumeOne({
          model,
          where: withTenantWhere(where, ctx.tenantId),
        });
      }
      return inner.consumeOne({ model, where });
    },

    createSchema: inner.createSchema,
    options: inner.options,
  };
}

export function wrappedStorefrontAdapter(
  inner: DBAdapter,
  resolveTenantContext: ResolveTenantContext,
): DBAdapter {
  const wrapped = wrapMethods(inner, resolveTenantContext);
  return {
    ...wrapped,
    transaction: async (cb) =>
      inner.transaction((trx) => cb(wrapMethods(trx, resolveTenantContext))),
  };
}
