/**
 * Better-Auth configuration for the PLATFORM app (admin.deliverse.app)
 *
 * Audience: platform staff + tenant operators
 * Methods: email/password + Google OAuth
 *
 * Mappings per docs/specs/better-auth-config-v1.md §7. All `fields:` values
 * are Drizzle property keys (camelCase), NOT SQL column names — see ADR 0007.
 */

import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { organization } from 'better-auth/plugins';
import { createAccessControl } from 'better-auth/plugins/access';
import { defaultStatements } from 'better-auth/plugins/organization/access';
import { db } from '@rp/db';
import * as schema from '@rp/db/schema';

const ac = createAccessControl(defaultStatements);

const owner = ac.newRole({
  organization: ['update', 'delete'],
  member: ['create', 'update', 'delete'],
  invitation: ['create', 'cancel'],
});

const manager = ac.newRole({
  organization: ['update'],
  member: ['create', 'update', 'delete'],
  invitation: ['create', 'cancel'],
});

const staff = ac.newRole({});

const viewer = ac.newRole({});

export const platformAuth = betterAuth({
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

  secret: process.env.BETTER_AUTH_SECRET,
  baseURL: process.env.BETTER_AUTH_URL,

  user: {
    fields: {
      emailVerified: 'emailVerified',
      image: 'imageUrl',
    },
    additionalFields: {
      deletedAt: {
        type: 'date',
        required: false,
        input: false,
      },
    },
  },

  account: {
    fields: {
      userId: 'platformUserId',
    },
  },

  session: {
    fields: {
      userId: 'platformUserId',
    },
    expiresIn: 60 * 60 * 24 * 30,
    updateAge: 60 * 60 * 24 * 7,
    cookieCache: {
      enabled: true,
      maxAge: 60 * 5,
    },
  },

  emailAndPassword: {
    enabled: true,
    minPasswordLength: 12,
    maxPasswordLength: 128,
    autoSignIn: false,
    sendResetPassword: async ({ user, url }) => {
      console.log(`[DEV] Password reset for ${user.email}: ${url}`);
    },
  },

  emailVerification: {
    sendOnSignUp: true,
    autoSignInAfterVerification: true,
    sendVerificationEmail: async ({ user, url }) => {
      console.log(`[DEV] Verify email for ${user.email}: ${url}`);
    },
  },

  socialProviders: {
    google: {
      clientId: process.env.GOOGLE_CLIENT_ID || '',
      clientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
    },
  },

  advanced: {
    cookiePrefix: 'rp_platform',
    crossSubDomainCookies: {
      enabled: false,
    },
    defaultCookieAttributes: {
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      httpOnly: true,
    },
  },

  plugins: [
    organization({
      ac,
      roles: { owner, manager, staff, viewer },
      creatorRole: 'owner',
      allowUserToCreateOrganization: false,
      organizationLimit: 10,
      membershipLimit: 100,
      schema: {
        member: {
          fields: {
            organizationId: 'tenantId',
            userId: 'platformUserId',
          },
        },
        invitation: {
          fields: {
            organizationId: 'tenantId',
          },
        },
      },
    }),
  ],
});

export type PlatformAuth = typeof platformAuth;
export type PlatformSession = Awaited<
  ReturnType<typeof platformAuth.api.getSession>
>;
