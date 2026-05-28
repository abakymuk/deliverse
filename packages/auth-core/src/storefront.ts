/**
 * Better-Auth configuration for the STOREFRONT app ({brand}.deliverse.app)
 *
 * Audience: restaurant guests (end users)
 * Methods: email OTP (primary) + email/password + Google OAuth (hybrid)
 *
 * Mappings per docs/specs/better-auth-config-v1.md §8. All `fields:` values
 * are Drizzle property keys (camelCase), NOT SQL column names — see ADR 0007.
 *
 * SCOPE (DEL-3 + DEL-12): the storefront BA is constructed via the factory
 * `createStorefrontAuth(resolveTenantContext)` and wraps the Drizzle adapter
 * via `wrappedStorefrontAdapter` (docs/specs/storefront-tenant-scoping.md).
 * The wrapper stamps `tenant_id` / `current_brand_id` / `verification.type`
 * on creates and adds `tenant_id` predicates on reads for the
 * `user`, `verification`, and `account` models. OAuth signup is unblocked
 * as of DEL-12 (schema migration 0002 + `account.additionalFields.tenantId`
 * registration below + `account` added to `SCOPED_MODELS`).
 */

import { db } from '@rp/db';
import * as schema from '@rp/db/schema';
import { inngest } from '@rp/emails/inngest';
import { type BetterAuthOptions, betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { emailOTP } from 'better-auth/plugins';
import { type ResolveTenantContext, wrappedStorefrontAdapter } from './storefront-adapter';
import { isAllowedStorefrontOrigin } from './storefront-origin';
import { rewriteStorefrontEmailUrl } from './storefront-url';

export { isAllowedStorefrontOrigin };
export type { ResolveTenantContext, StorefrontTenantContext } from './storefront-adapter';

export function createStorefrontAuth(resolveTenantContext: ResolveTenantContext) {
  return betterAuth({
    database: (options: BetterAuthOptions) =>
      wrappedStorefrontAdapter(
        drizzleAdapter(db, {
          provider: 'pg',
          schema: {
            user: schema.tenantEndUsers,
            account: schema.tenantEndUserAccounts,
            session: schema.tenantEndUserSessions,
            verification: schema.tenantEndUserVerifications,
          },
        })(options),
        resolveTenantContext,
      ),

    secret: process.env.BETTER_AUTH_SECRET,

    user: {
      fields: {
        emailVerified: 'emailVerified',
        image: 'imageUrl',
      },
      additionalFields: {
        tenantId: {
          type: 'string',
          required: false,
          input: false,
        },
        phone: {
          type: 'string',
          required: false,
        },
        deletedAt: {
          type: 'date',
          required: false,
          input: false,
        },
      },
    },

    account: {
      fields: {
        userId: 'tenantEndUserId',
      },
      additionalFields: {
        // DEL-12: BA's getAuthTables(options) only transforms fields it knows
        // about. Without this registration, the adapter wrapper's injected
        // data.tenantId on account.create would be dropped by the factory's
        // transformInput (@better-auth/core/dist/db/adapter/factory.mjs).
        // `input: false` is defense-in-depth — external callers cannot spoof.
        tenantId: {
          type: 'string',
          required: false,
          input: false,
        },
      },
    },

    session: {
      fields: {
        userId: 'tenantEndUserId',
      },
      additionalFields: {
        currentBrandId: {
          type: 'string',
          required: false,
          input: false,
        },
        // Session tenant scoping — closes the cross-tenant cookie-replay
        // defense-in-depth gap surfaced during DEL-26. `input: false` mirrors
        // the DEL-12 `account.additionalFields.tenantId` pattern: external
        // HTTP callers cannot spoof, and BA's factory `transformInput` only
        // preserves declared additionalFields by name (without this
        // registration, the wrapper-injected `data.tenantId` would be
        // dropped). See docs/specs/session-model-scoped.md.
        tenantId: {
          type: 'string',
          required: false,
          input: false,
        },
      },
      expiresIn: 60 * 60 * 24 * 30,
      updateAge: 60 * 60 * 24 * 7,
      // cookie-cache-tenant-version: the `version` callback closes the
      // cross-tenant cookie-replay gap that session-model-scoped (PR #76)
      // left open. BA invokes this callback at both cache-write time
      // (post-signup/signin, via `dist/cookies/index.mjs:69-86`) and
      // cache-read time (every `get-session` cookieCache hit, via
      // `dist/api/routes/session.mjs:93-104`). At write time it runs in
      // the writer-tenant's request context → returns writer's tenantId,
      // stamped into the cached payload's `version` field. At read time
      // it runs in the reader-tenant's request context → returns reader's
      // tenantId. Mismatch on cross-tenant replay → BA expires the
      // session_data cookie → falls through to the adapter's findSession
      // → wrapped adapter's tenant predicate excludes the cross-tenant
      // session → BA returns null user.
      //
      // The closure-captured `resolveTenantContext` is the same one the
      // wrapped adapter uses (single source of truth for request →
      // tenant). Cross-package boundary: `packages/auth-core` does NOT
      // import app code — the resolver body lives in the app
      // (`apps/storefront/src/lib/storefront-tenant-context.ts`) and is
      // passed in via `createStorefrontAuth(resolveTenantContext)`.
      //
      // The bare-host page-render path (Next.js 16 drops storefront
      // subdomain from Host on post-server-action-redirect renders) is
      // handled by the resolver's Referer/Origin fallback + the proxy's
      // matching `x-storefront-id` injection, so the callback never
      // throws on a real RSC render. See
      // docs/specs/cookie-cache-tenant-version.md AC#3 + AC#4.
      cookieCache: {
        enabled: true,
        maxAge: 60 * 5,
        version: async () => {
          const ctx = await resolveTenantContext();
          return ctx.tenantId;
        },
      },
    },

    verification: {
      additionalFields: {
        tenantId: {
          type: 'string',
          required: false,
          input: false,
        },
        brandId: {
          type: 'string',
          required: false,
          input: false,
        },
        type: {
          type: 'string',
          required: false,
          input: false,
        },
        attempts: {
          type: 'number',
          required: false,
          input: false,
          defaultValue: 0,
        },
      },
    },

    emailAndPassword: {
      enabled: true,
      minPasswordLength: 8,
      maxPasswordLength: 128,
      autoSignIn: true,
      sendResetPassword: async ({ user, url }) => {
        const ctx = await resolveTenantContext();
        // DEL-15: BA freezes ctx.context.baseURL at init time from
        // BETTER_AUTH_URL (= platform host). Storefront BA is multi-tenant,
        // so we rewrite the origin per-request to the user's storefront
        // subdomain. DEL-22: storefrontSlug works for both brand-host and
        // tenant-host modes (the slug IS the matched subdomain).
        const baseDomain = process.env.NEXT_PUBLIC_STOREFRONT_BASE_DOMAIN;
        if (!baseDomain) {
          throw new Error(
            'NEXT_PUBLIC_STOREFRONT_BASE_DOMAIN is required for storefront BA reset URLs (DEL-15)',
          );
        }
        const proto = process.env.NODE_ENV === 'production' ? 'https' : 'http';
        const rewrittenUrl = rewriteStorefrontEmailUrl({
          originalUrl: url,
          storefrontSlug: ctx.storefrontSlug,
          baseDomain,
          proto,
        });
        // DEL-22: emit per-mode payload. Brand-mode is verbatim today's shape
        // (no `mode` field → back-compat with in-flight Inngest events).
        // Tenant-mode adds `mode: 'tenant'` + storefrontId/storefrontSlug for
        // the email-branding fallback in @rp/emails.
        if (ctx.storefrontType === 'brand') {
          await inngest.send({
            name: 'email.password_reset.requested',
            data: {
              instance: 'storefront',
              email: user.email,
              userId: user.id,
              url: rewrittenUrl,
              tenantId: ctx.tenantId,
              // biome-ignore lint/style/noNonNullAssertion: type narrowing on
              // ctx.storefrontType==='brand' guarantees brandSlug presence
              // (see StorefrontTenantContext in storefront-adapter.ts).
              brandSlug: ctx.brandSlug!,
            },
          });
        } else {
          await inngest.send({
            name: 'email.password_reset.requested',
            data: {
              instance: 'storefront',
              mode: 'tenant',
              email: user.email,
              userId: user.id,
              url: rewrittenUrl,
              tenantId: ctx.tenantId,
              storefrontId: ctx.storefrontId,
              storefrontSlug: ctx.storefrontSlug,
            },
          });
        }
      },
    },

    socialProviders: {
      google: {
        clientId: process.env.GOOGLE_CLIENT_ID || '',
        clientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
      },
    },

    advanced: {
      // BA generates IDs for sessions/accounts/verifications. Our schema columns
      // are `uuid` type (DEL-10), so BA's default base64-ish IDs would fail with
      // PostgresError: invalid input syntax for type uuid. The 'uuid' magic
      // string tells BA to emit RFC-4122 UUIDs via crypto.randomUUID().
      database: {
        generateId: 'uuid',
      },
      cookiePrefix: 'rp_store',
      crossSubDomainCookies: {
        enabled: false,
      },
      defaultCookieAttributes: {
        sameSite: 'lax',
        secure: process.env.NODE_ENV === 'production',
        httpOnly: true,
      },
    },

    trustedOrigins: async (request) => {
      if (!request) return [];
      const host = request.headers.get('host');
      const baseDomain = process.env.NEXT_PUBLIC_STOREFRONT_BASE_DOMAIN;
      if (!host || !isAllowedStorefrontOrigin(host, baseDomain)) return [];
      const proto = process.env.NODE_ENV === 'production' ? 'https' : 'http';
      return [`${proto}://${host.toLowerCase()}`];
    },

    plugins: [
      emailOTP({
        storeOTP: 'hashed',
        otpLength: 6,
        expiresIn: 60 * 10,
        // DEL-9: 5 failed verify attempts triggers BA's TOO_MANY_ATTEMPTS
        // path (deletes the verification row, throws FORBIDDEN). Our wrapped
        // adapter observes the value-encoded attempts counter on
        // verification.update and inserts a tenant_otp_lockouts row BEFORE
        // BA's delete, so the 15-min cooldown survives the row's lifecycle.
        // See packages/auth-core/src/rate-limit.ts + storefront-adapter.ts.
        allowedAttempts: 5,
        disableSignUp: false,
        sendVerificationOTP: async ({ email, otp, type }) => {
          // BA's emailOTP plugin uses hyphenated enum values
          // ('sign-in' | 'email-verification' | 'forget-password'); our
          // Inngest event schema (events.ts in @rp/emails) uses the
          // snake_case verification-type values we standardized on in
          // DEL-3 (see deriveVerificationType in storefront-verification-type.ts).
          const eventType =
            type === 'sign-in'
              ? 'otp_login'
              : type === 'email-verification'
                ? 'email_verify'
                : 'password_reset';
          const ctx = await resolveTenantContext();
          // DEL-22: emit per-mode payload. Brand-mode is verbatim today's
          // shape (no `mode` field → back-compat); tenant-mode adds
          // mode: 'tenant' + storefrontId/storefrontSlug for the
          // email-branding fallback in @rp/emails.
          if (ctx.storefrontType === 'brand') {
            await inngest.send({
              name: 'email.otp.requested',
              data: {
                email,
                otp,
                type: eventType,
                tenantId: ctx.tenantId,
                // biome-ignore lint/style/noNonNullAssertion: type narrowing
                // on ctx.storefrontType==='brand' guarantees brandSlug presence.
                brandSlug: ctx.brandSlug!,
              },
            });
          } else {
            await inngest.send({
              name: 'email.otp.requested',
              data: {
                email,
                otp,
                type: eventType,
                tenantId: ctx.tenantId,
                mode: 'tenant',
                storefrontId: ctx.storefrontId,
                storefrontSlug: ctx.storefrontSlug,
              },
            });
          }
        },
      }),
    ],
  });
}

export type StorefrontAuth = ReturnType<typeof createStorefrontAuth>;
export type StorefrontSession = Awaited<ReturnType<StorefrontAuth['api']['getSession']>>;
