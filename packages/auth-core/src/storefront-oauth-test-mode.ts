/**
 * Test-mode Google OAuth hooks for the storefront BA.
 *
 * Gated on `BA_OAUTH_TEST_MODE === '1'` in storefront.ts. The CI workflow
 * sets this for the storefront e2e job only — **never set in dev / stg /
 * prd** (the hook overrides become dead code in those envs).
 *
 * ## Design — why hook overrides, not a full OAuth dance
 *
 * BA's `/sign-in/social` endpoint has TWO branches
 * (`dist/api/routes/sign-in.mjs:76-141`):
 *
 *   1. **idToken-direct** (line 76-128): when `body.idToken` is provided,
 *      BA calls `provider.verifyIdToken(token, nonce)` + `provider.getUserInfo({idToken, ...})`
 *      directly. NO `validateAuthorizationCode`, NO browser-redirect dance.
 *   2. **Redirect** (line 129+): the standard OAuth flow — generates a
 *      Google authorize URL, browser navigates, callback runs
 *      `validateAuthorizationCode` → `getUserInfo`.
 *
 * Both branches converge on `handleOAuthUserInfo(c, {userInfo, account, ...})`
 * (sign-in.mjs:100 + callback.mjs:148 — identical call site). Same
 * account-creation, tenant-scoping (DEL-12 wrapped adapter), and
 * session-creation logic.
 *
 * The test uses **branch 1**:
 *
 *   - **Why it works:** BA's Google provider exposes config-level overrides
 *     for `verifyIdToken` and `getUserInfo` (verified at
 *     `node_modules/.pnpm/@better-auth+core@1.6.11_<hash>/node_modules/@better-auth/core/dist/social-providers/google.mjs:63-97`).
 *   - **Why we avoid branch 2:** BA 1.6.11's Google provider has NO
 *     override hook for `validateAuthorizationCode` (verified at the same
 *     file lines 43-51) — it's hardcoded to fetch `oauth2.googleapis.com/token`.
 *     Closing that gap would require either monkey-patching BA's
 *     `socialProviders.google` import (fragile across upgrades) or
 *     installing an undici MockAgent for the token endpoint (intrusive at
 *     module load). The idToken-direct branch sidesteps the problem
 *     entirely.
 *
 * ## Token shape
 *
 * Fake idTokens are not real JWTs — they're a recognisable prefix +
 * base64url(JSON(claims)) suffix. The prefix lets `verifyIdToken` reject
 * non-test tokens as a defense-in-depth measure even if the env var leaks.
 *
 *   `fake-google-id-<base64url-claims>`
 *
 * The test helper at `apps/storefront/tests/e2e/helpers/oauth-double.ts`
 * imports `encodeFakeGoogleIdToken` and POSTs the result as
 * `body.idToken.token` to `/api/auth/sign-in/social`.
 *
 * Spec: docs/specs/del-12-oauth-e2e.md.
 */

type FakeClaims = {
  uid: string;
  email: string;
  emailVerified: boolean;
  name: string;
};

const PREFIX = 'fake-google-id-';

function b64urlEncode(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64url');
}

function b64urlDecode(s: string): string | null {
  try {
    return Buffer.from(s, 'base64url').toString('utf8');
  } catch {
    return null;
  }
}

/**
 * Build a fake idToken string for BA's `/sign-in/social` idToken branch.
 * Encodes the user claims as a base64url-JSON suffix on the prefix; the
 * complementary {@link testModeGoogleHooks} verifies + decodes them.
 *
 * Test-only export. Production never sets `BA_OAUTH_TEST_MODE` so the
 * consumer hooks are inert; tokens generated here are unusable in prd.
 */
export function encodeFakeGoogleIdToken(claims: FakeClaims): string {
  return `${PREFIX}${b64urlEncode(JSON.stringify(claims))}`;
}

/** Exposed for unit tests + diagnostics. Not used by the runtime hooks. */
export function decodeFakeGoogleIdToken(token: string): FakeClaims | null {
  if (!token.startsWith(PREFIX)) return null;
  const raw = b64urlDecode(token.slice(PREFIX.length));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<FakeClaims>;
    if (
      typeof parsed.uid !== 'string' ||
      typeof parsed.email !== 'string' ||
      typeof parsed.name !== 'string' ||
      typeof parsed.emailVerified !== 'boolean'
    ) {
      return null;
    }
    return parsed as FakeClaims;
  } catch {
    return null;
  }
}

/**
 * BA `socialProviders.google` test-mode hook overrides. Spread into the
 * Google config in `storefront.ts` when `BA_OAUTH_TEST_MODE === '1'`:
 *
 *     ...(process.env.BA_OAUTH_TEST_MODE === '1' ? testModeGoogleHooks : {})
 *
 * Both signatures verified at BA 1.6.11 source
 * (`@better-auth/core/dist/social-providers/google.mjs:63-97`):
 *
 *   - `verifyIdToken(token: string, nonce?: string): Promise<boolean>`
 *     — returns true if the token decodes; false otherwise. Defense-in-
 *     depth: even if the env var accidentally ships to prd, this only
 *     accepts tokens with our specific prefix + valid base64url-JSON
 *     payload. Still unsafe in prd; the layered defense is "don't set the
 *     env var" + "we still don't accept arbitrary tokens."
 *   - `getUserInfo(token: {idToken?, accessToken?, refreshToken?, user?}): Promise<{user, data} | null>`
 *     — decodes the claims and returns BA's `{user, data}` shape per
 *     `dist/api/routes/sign-in.mjs:86` consumer expectation.
 */
export const testModeGoogleHooks = {
  verifyIdToken: async (token: string, _nonce?: string): Promise<boolean> => {
    return decodeFakeGoogleIdToken(token) !== null;
  },

  getUserInfo: async (token: {
    idToken?: string;
    accessToken?: string;
    refreshToken?: string;
    user?: unknown;
  }): Promise<{
    user: {
      id: string;
      email: string;
      emailVerified: boolean;
      name: string;
      image: string | undefined;
    };
    data: Record<string, unknown>;
  } | null> => {
    if (!token.idToken) return null;
    const claims = decodeFakeGoogleIdToken(token.idToken);
    if (!claims) return null;
    return {
      user: {
        id: claims.uid,
        email: claims.email,
        emailVerified: claims.emailVerified,
        name: claims.name,
        // BA expects `image: string | undefined` (not `null`) — we omit
        // the picture for fake users.
        image: undefined,
      },
      data: {
        // Mirrors the shape of Google's userinfo / id_token claims. BA
        // stores this on `account.providerData` for the redirect flow;
        // idToken-direct branch passes it through `handleOAuthUserInfo`
        // for the same downstream consumers.
        sub: claims.uid,
        email: claims.email,
        email_verified: claims.emailVerified,
        name: claims.name,
      },
    };
  },
};
