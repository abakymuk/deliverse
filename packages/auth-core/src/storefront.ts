/**
 * Better-Auth configuration for the STOREFRONT app ({brand}.yourapp.com)
 *
 * Audience: restaurant guests (end users)
 * Methods: email OTP (primary) + email/password + Google OAuth (hybrid)
 *
 * Maps our custom table names to Better-Auth's expected models:
 *   tenant_end_users          → "user"
 *   tenant_end_user_accounts  → "account"
 *   tenant_end_user_sessions  → "session"
 *   tenant_end_user_verifications → "verification"
 *
 * CRITICAL: end users are tenant-scoped. Tenant resolution happens in
 * middleware BEFORE auth, and tenantId is injected into the request context.
 */

import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { emailOTP } from 'better-auth/plugins';
import { db } from '@rp/db';
import * as schema from '@rp/db/schema';

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
  // baseURL is set dynamically per-tenant in middleware

  user: {
    fields: {
      emailVerified: 'email_verified_at',
      image: 'image_url',
    },
    additionalFields: {
      tenantId: {
        type: 'string',
        required: true,
        input: false, // Set by middleware, not by user
      },
      deletedAt: {
        type: 'date',
        required: false,
        input: false,
      },
    },
  },

  // === Email + Password (hybrid) ===
  // End users CAN set a password as alternative to OTP.
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 8,
    maxPasswordLength: 128,
    autoSignIn: true,
    sendResetPassword: async ({ user, url }) => {
      // TODO: integrate Resend with brand-themed template
      console.log(`[DEV] Password reset for ${user.email}: ${url}`);
    },
  },

  // === Google OAuth ===
  socialProviders: {
    google: {
      clientId: process.env.GOOGLE_CLIENT_ID || '',
      clientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
    },
  },

  // === Session config ===
  // End users get longer sessions — they log in rarely.
  session: {
    expiresIn: 60 * 60 * 24 * 30, // 30 days
    updateAge: 60 * 60 * 24 * 7,
    cookieCache: {
      enabled: true,
      maxAge: 60 * 5,
    },
  },

  // === Cookie config ===
  // Per-brand-subdomain scoped. Cookie domain set dynamically per request.
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

  // === Plugins ===
  plugins: [
    emailOTP({
      sendVerificationOTP: async ({ email, otp, type }) => {
        // TODO: integrate Resend with brand-themed template
        // The brand context is available via the request — pass through
        // headers or use a request-scoped store.
        console.log(`[DEV] OTP for ${email} (${type}): ${otp}`);
      },
      otpLength: 6,
      expiresIn: 60 * 10, // 10 minutes
      disableSignUp: false, // Allow new signups via OTP
    }),
  ],
});

export type StorefrontAuth = typeof storefrontAuth;
export type StorefrontSession = Awaited<
  ReturnType<typeof storefrontAuth.api.getSession>
>;
