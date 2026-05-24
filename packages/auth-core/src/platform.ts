/**
 * Better-Auth configuration for the PLATFORM app (admin.yourapp.com)
 *
 * Audience: platform staff + tenant operators
 * Methods: email/password + Google OAuth
 *
 * Maps our custom table names to Better-Auth's expected models:
 *   platform_users         → "user"
 *   platform_accounts      → "account"
 *   platform_sessions      → "session"
 *   platform_verifications → "verification"
 *
 * Organization plugin maps to:
 *   tenants               → "organization"
 *   tenant_memberships    → "member"
 *   tenant_invitations    → "invitation"
 */

import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { organization } from 'better-auth/plugins';
import { db } from '@rp/db';
import * as schema from '@rp/db/schema';

export const platformAuth = betterAuth({
  // === Database adapter ===
  database: drizzleAdapter(db, {
    provider: 'pg',
    schema: {
      user: schema.platformUsers,
      account: schema.platformAccounts,
      session: schema.platformSessions,
      verification: schema.platformVerifications,
      organization: schema.tenants,
      member: schema.tenantMemberships,
      invitation: schema.tenantInvitations,
    },
  }),

  // === Secret (from env) ===
  secret: process.env.BETTER_AUTH_SECRET,
  baseURL: process.env.BETTER_AUTH_URL,

  // === Custom field mappings ===
  // BA expects field "emailVerified" (boolean) but we use "emailVerifiedAt" (timestamp).
  // BA expects "image" but we use "imageUrl".
  user: {
    fields: {
      emailVerified: 'email_verified_at',
      image: 'image_url',
    },
    additionalFields: {
      deletedAt: {
        type: 'date',
        required: false,
        input: false, // Don't allow user to set this
      },
    },
  },

  // === Email + Password ===
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 12,
    maxPasswordLength: 128,
    autoSignIn: false, // Require email verification first
    sendResetPassword: async ({ user, url }) => {
      // TODO: integrate Resend
      console.log(`[DEV] Password reset for ${user.email}: ${url}`);
    },
  },

  // === Email verification ===
  emailVerification: {
    sendOnSignUp: true,
    autoSignInAfterVerification: true,
    sendVerificationEmail: async ({ user, url }) => {
      // TODO: integrate Resend
      console.log(`[DEV] Verify email for ${user.email}: ${url}`);
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
  session: {
    expiresIn: 60 * 60 * 24 * 30, // 30 days absolute
    updateAge: 60 * 60 * 24 * 7,  // refresh every 7 days
    cookieCache: {
      enabled: true,
      maxAge: 60 * 5, // 5 minutes
    },
  },

  // === Cookie config ===
  // CRITICAL: scoped to admin.yourapp.com only, NOT wildcard.
  advanced: {
    cookiePrefix: 'rp_platform',
    crossSubDomainCookies: {
      enabled: false, // Explicit: do NOT share with storefronts
    },
    defaultCookieAttributes: {
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      httpOnly: true,
    },
  },

  // === Plugins ===
  plugins: [
    organization({
      // Multi-tenancy: users belong to organizations (tenants) with roles
      allowUserToCreateOrganization: false, // Only invited users
      organizationLimit: 10, // Max tenants per user (e.g., chain franchise manager)
      membershipLimit: 100, // Max members per tenant in v1
      creatorRole: 'owner',
      roles: ['owner', 'manager', 'staff', 'viewer'],
    }),
  ],
});

export type PlatformAuth = typeof platformAuth;
export type PlatformSession = Awaited<
  ReturnType<typeof platformAuth.api.getSession>
>;
