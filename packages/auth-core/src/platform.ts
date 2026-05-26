/**
 * Better-Auth configuration for the PLATFORM app (admin.deliverse.app)
 *
 * Audience: platform staff + tenant operators
 * Methods: email/password + Google OAuth
 *
 * Mappings per docs/specs/better-auth-config-v1.md §7. All `fields:` values
 * are Drizzle property keys (camelCase), NOT SQL column names — see ADR 0007.
 */

import { db } from '@rp/db';
import * as schema from '@rp/db/schema';
import { inngest } from '@rp/emails/inngest';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { organization } from 'better-auth/plugins';
import { createAccessControl } from 'better-auth/plugins/access';
import { defaultStatements } from 'better-auth/plugins/organization/access';

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
      await inngest.send({
        name: 'email.password_reset.requested',
        data: { instance: 'platform', email: user.email, userId: user.id, url },
      });
    },
  },

  emailVerification: {
    sendOnSignUp: true,
    autoSignInAfterVerification: true,
    sendVerificationEmail: async ({ user, url }) => {
      await inngest.send({
        name: 'email.email_verification.requested',
        data: { instance: 'platform', email: user.email, userId: user.id, url },
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
      // DEL-13: BA's organization plugin does NOT construct the invite URL —
      // the callback must build it from `data.id`. Default invitation TTL is
      // 48h (BA's `invitationExpiresIn || 3600 * 48`). The URL points at
      // platform's `/signup?token=<id>` page (DEL-7) which consumes the token
      // and triggers the accept-invitation hook post-signup.
      sendInvitationEmail: async (data) => {
        const baseURL = process.env.BETTER_AUTH_URL;
        if (!baseURL) {
          throw new Error('BETTER_AUTH_URL is required for invitation emails (DEL-13)');
        }
        // `new URL(...)` instead of string concat avoids `https://host//signup`
        // if BETTER_AUTH_URL has a trailing slash; keeps query encoding correct.
        const inviteUrl = new URL('/signup', baseURL);
        inviteUrl.searchParams.set('token', data.id);

        await inngest.send({
          name: 'email.invitation.requested',
          data: {
            instance: 'platform',
            email: data.email,
            invitationId: data.id,
            role: data.role,
            // Defensive fallbacks: BA permits empty user.name; our Zod schema
            // requires .min(1). Without these, a blank name would poison the
            // event forever under Inngest's retry policy.
            inviterName: data.inviter.user.name || data.inviter.user.email || 'A teammate',
            organizationName: data.organization.name || 'your organization',
            url: inviteUrl.toString(),
          },
        });
      },
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
export type PlatformSession = Awaited<ReturnType<typeof platformAuth.api.getSession>>;
