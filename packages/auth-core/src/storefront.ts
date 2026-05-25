/**
 * Better-Auth configuration for the STOREFRONT app ({brand}.deliverse.app)
 *
 * Audience: restaurant guests (end users)
 * Methods: email OTP (primary) + email/password + Google OAuth (hybrid)
 *
 * Mappings per docs/specs/better-auth-config-v1.md §8. All `fields:` values
 * are Drizzle property keys (camelCase), NOT SQL column names — see ADR 0007.
 *
 * SCOPE WARNING (DEL-11): this instance is guard-only. Every write path that
 * needs tenantId / currentBrandId / verification.type throws a typed
 * BetterAuthError because hooks cannot inject `input:false` fields (two-pass
 * input parser — see spec §4). DEL-3 wires the real tenant injection.
 */

import { betterAuth, BetterAuthError } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { emailOTP } from 'better-auth/plugins';
import { db } from '@rp/db';
import * as schema from '@rp/db/schema';
import { isAllowedStorefrontOrigin } from './storefront-origin';

export { isAllowedStorefrontOrigin };

export const storefrontAuth = betterAuth({
  database: drizzleAdapter(db, {
    provider: 'pg',
    schema: {
      user: schema.tenantEndUsers,
      account: schema.tenantEndUserAccounts,
      session: schema.tenantEndUserSessions,
      verification: schema.tenantEndUserVerifications,
    },
  }),

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
      console.log(`[DEV] Password reset for ${user.email}: ${url}`);
    },
  },

  socialProviders: {
    google: {
      clientId: process.env.GOOGLE_CLIENT_ID || '',
      clientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
    },
  },

  advanced: {
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
    if (!isAllowedStorefrontOrigin(host, baseDomain)) return [];
    const proto = process.env.NODE_ENV === 'production' ? 'https' : 'http';
    return [`${proto}://${host!.toLowerCase()}`];
  },

  databaseHooks: {
    user: {
      create: {
        before: async (user) => {
          if (!(user as { tenantId?: string }).tenantId) {
            throw new BetterAuthError(
              'tenant_id missing on storefront user create (DEL-11 stub; DEL-3 wires the real injection path)',
            );
          }
        },
      },
    },
    session: {
      create: {
        before: async (session) => {
          if (!(session as { currentBrandId?: string }).currentBrandId) {
            throw new BetterAuthError(
              'current_brand_id missing on storefront session create (DEL-11 stub; DEL-3 wires the real injection path)',
            );
          }
        },
      },
    },
    verification: {
      create: {
        before: async (verification) => {
          const v = verification as { tenantId?: string; type?: string };
          if (!v.tenantId) {
            throw new BetterAuthError(
              'tenant_id missing on storefront verification create (DEL-11 stub; DEL-3 wires the real injection path)',
            );
          }
          if (!v.type) {
            throw new BetterAuthError(
              'verification.type missing (must be one of otp_login | email_verify | password_reset) — DEL-11 stub; DEL-3 wires the real injection path',
            );
          }
        },
      },
    },
  },

  plugins: [
    emailOTP({
      storeOTP: 'hashed',
      otpLength: 6,
      expiresIn: 60 * 10,
      disableSignUp: false,
      sendVerificationOTP: async ({ email, otp, type }) => {
        console.log(`[DEV] OTP for ${email} (${type}): ${otp}`);
      },
    }),
  ],
});

export type StorefrontAuth = typeof storefrontAuth;
export type StorefrontSession = Awaited<
  ReturnType<typeof storefrontAuth.api.getSession>
>;
