'use client';

import { createAuthClient } from 'better-auth/react';
import { emailOTPClient } from 'better-auth/client/plugins';

/**
 * Storefront auth client.
 *
 * baseURL is set dynamically — each brand has its own subdomain,
 * but the auth API still lives at the same path.
 */
export const authClient = createAuthClient({
  // baseURL determined from window.location at runtime in browser
  plugins: [emailOTPClient()],
});

export const {
  signIn,
  signUp,
  signOut,
  useSession,
  getSession,
  emailOtp,
} = authClient;
