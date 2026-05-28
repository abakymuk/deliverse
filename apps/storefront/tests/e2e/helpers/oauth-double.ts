/**
 * Test-mode Google OAuth helper for the storefront e2e suite.
 *
 * Drives BA's `/api/auth/sign-in/social` **idToken-direct branch**
 * (`node_modules/better-auth/dist/api/routes/sign-in.mjs:76-128`) — no
 * browser-OAuth-redirect dance required. The corresponding server-side
 * BA hook overrides live in
 * `packages/auth-core/src/storefront-oauth-test-mode.ts` and are gated
 * on `BA_OAUTH_TEST_MODE === '1'`. CI sets the flag for the storefront
 * e2e job ONLY; prd / stg / dev never set it.
 *
 * Why HTTP-driven instead of `page.route()` + browser intercept:
 *   - BA 1.6.11's Google provider has NO config-level override hook for
 *     `validateAuthorizationCode` (verified at
 *     @better-auth/core/dist/social-providers/google.mjs:43-51). The
 *     redirect-callback flow can't be intercepted without monkey-patching
 *     BA's `socialProviders.google` import or installing a fetch
 *     interceptor for `oauth2.googleapis.com/token`.
 *   - BA's idToken-direct branch skips `validateAuthorizationCode`
 *     entirely. It calls `verifyIdToken` + `getUserInfo` — both of which
 *     CAN be overridden via config — and converges with the redirect
 *     branch on the same `handleOAuthUserInfo` call site
 *     (sign-in.mjs:100 = callback.mjs:148). Same account-creation,
 *     tenant-scoping (DEL-12), and session-creation logic.
 *
 * Spec: docs/specs/del-12-oauth-e2e.md.
 */

import { type APIRequestContext, expect } from '@playwright/test';
import { encodeFakeGoogleIdToken } from '@rp/auth-core/storefront-oauth-test-mode';

const STOREFRONT_PORT = 3001;

export type FakeGoogleUser = {
  /** Deterministic Google uid the test will assert on. */
  uid: string;
  email: string;
  name?: string;
  emailVerified?: boolean;
};

export type FakeGoogleSignInResult = {
  /** BA's session token (also set as a cookie on the response). */
  sessionToken: string;
  /** Storefront end-user UUID created/linked by this signin. */
  userId: string;
  /** Raw `Set-Cookie` header values (e.g., for cross-tenant replay assertions). */
  setCookies: string[];
};

/**
 * POST to `/api/auth/sign-in/social` with a fake idToken-direct payload.
 * Returns the BA session token + user id + raw Set-Cookie values for the
 * given storefront slug.
 *
 * **Requires** `BA_OAUTH_TEST_MODE=1` set in the env the Next.js dev
 * server reads (CI: workflow step; locally: `BA_OAUTH_TEST_MODE=1
 * doppler run --config dev -- pnpm dev` from `apps/storefront`). Without
 * the flag, BA's default `verifyIdToken` runs real Google JWT
 * verification and rejects the fake token with 401.
 */
export async function signInWithFakeGoogle(
  request: APIRequestContext,
  storefrontSlug: string,
  user: FakeGoogleUser,
  options: { callbackURL?: string } = {},
): Promise<FakeGoogleSignInResult> {
  const idTokenString = encodeFakeGoogleIdToken({
    uid: user.uid,
    email: user.email,
    emailVerified: user.emailVerified ?? true,
    name: user.name ?? user.email.split('@')[0] ?? 'Fake Google User',
  });

  const origin = `http://${storefrontSlug}.localhost:${STOREFRONT_PORT}`;
  const url = `${origin}/api/auth/sign-in/social`;

  const res = await request.post(url, {
    data: {
      provider: 'google',
      idToken: { token: idTokenString },
      callbackURL: options.callbackURL ?? '/account',
      // requestSignUp: true ensures BA creates the user even on first
      // contact with this fake-uid. Without it, if `disableImplicitSignUp`
      // were ever set (currently false in storefront.ts) the implicit
      // signup would be rejected.
      requestSignUp: true,
    },
    headers: { Origin: origin },
  });

  expect(
    res.status(),
    `signInWithFakeGoogle at ${storefrontSlug} body: ${await res.text()}`,
  ).toBe(200);

  type SignInResponse = {
    redirect: boolean;
    token: string;
    user: { id: string; email: string };
  };
  const body = (await res.json()) as SignInResponse;
  expect(body.user?.email, 'response must include the user').toBe(user.email);

  const setCookies = res
    .headersArray()
    .filter((h) => h.name.toLowerCase() === 'set-cookie')
    .map((h) => h.value);

  return {
    sessionToken: body.token,
    userId: body.user.id,
    setCookies,
  };
}
