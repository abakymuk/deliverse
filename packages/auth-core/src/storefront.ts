/**
 * Better-Auth configuration for the STOREFRONT app ({brand}.deliverse.app)
 *
 * Audience: restaurant guests (end users)
 * Methods: email OTP (primary) + email/password + Google OAuth (hybrid)
 *
 * Mappings per docs/specs/better-auth-config-v1.md §8. All `fields:` values
 * are Drizzle property keys (camelCase), NOT SQL column names — see ADR 0007.
 *
 * SCOPE (DEL-3): the storefront BA is now constructed via the factory
 * `createStorefrontAuth(resolveTenantContext)` and wraps the Drizzle adapter
 * via `wrappedStorefrontAdapter` (docs/specs/storefront-tenant-scoping.md).
 * The wrapper stamps `tenant_id` / `current_brand_id` / `verification.type`
 * on creates and adds `tenant_id` predicates on reads for the
 * `user` and `verification` models.
 *
 * REMAINING GAP (TODO DEL-3a): the `account` model is NOT wrapped because
 * `tenant_end_user_accounts(provider_id, account_id)` is globally unique.
 * This breaks OAuth account lookup across tenants. DEL-7 OAuth signup MUST
 * NOT ship until DEL-3a closes (schema delta + adapter scoping for `account`).
 */

import { db } from '@rp/db';
import * as schema from '@rp/db/schema';
import { inngest } from '@rp/emails/inngest';
import { type BetterAuthOptions, betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { emailOTP } from 'better-auth/plugins';
import { type ResolveTenantContext, wrappedStorefrontAdapter } from './storefront-adapter';
import { isAllowedStorefrontOrigin } from './storefront-origin';

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
      },
      expiresIn: 60 * 60 * 24 * 30,
      updateAge: 60 * 60 * 24 * 7,
      cookieCache: {
        enabled: true,
        maxAge: 60 * 5,
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
        await inngest.send({
          name: 'email.password_reset.requested',
          data: {
            instance: 'storefront',
            email: user.email,
            userId: user.id,
            url,
            tenantId: ctx.tenantId,
            brandSlug: ctx.brandSlug,
          },
        });
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
          await inngest.send({
            name: 'email.otp.requested',
            data: {
              email,
              otp,
              type: eventType,
              tenantId: ctx.tenantId,
              brandSlug: ctx.brandSlug,
            },
          });
        },
      }),
    ],
  });
}

export type StorefrontAuth = ReturnType<typeof createStorefrontAuth>;
export type StorefrontSession = Awaited<ReturnType<StorefrontAuth['api']['getSession']>>;
