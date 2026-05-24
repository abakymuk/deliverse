/**
 * Client-side auth helpers for the platform app.
 * Use in 'use client' components.
 */

import { createAuthClient } from 'better-auth/react';
import { organizationClient } from 'better-auth/client/plugins';

export const authClient = createAuthClient({
  baseURL: process.env.NEXT_PUBLIC_PLATFORM_URL,
  plugins: [organizationClient()],
});

export const {
  signIn,
  signUp,
  signOut,
  useSession,
  getSession,
  organization,
} = authClient;
