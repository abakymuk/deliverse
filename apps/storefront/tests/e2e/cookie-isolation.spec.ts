import { type APIRequestContext, expect, test } from '@playwright/test';
import { db } from '@rp/db';
import { tenantEndUsers } from '@rp/db/schema';
import { and, eq, isNull } from 'drizzle-orm';

/**
 * DEL-26 + cookie-cache-tenant-version — Cookie isolation across storefronts.
 *
 * **Test 1 (DEL-26 AC#6) — browser-side guard.** BA session cookies must be
 * `Domain`-scoped to the exact storefront subdomain (no wildcard leak).
 * A browser then refuses to send the cookie cross-storefront, so cross-
 * brand cookie leak cannot happen in a normal browsing flow. Sign up at
 * a brand host, inspect every `Set-Cookie` header on the response, and
 * assert no `Domain` is a wildcard (no leading `.`) and any explicit
 * `Domain` equals the exact subdomain.
 *
 * **Tests 2 + 3 (cookie-cache-tenant-version AC#6) — server-side guard.**
 * The threat model is explicit header injection / programmatic clients
 * that bypass the browser's `Domain` enforcement. Sign up at storefront
 * A, capture every `Set-Cookie` from the signup response, compose them
 * into a `Cookie:` request header, replay at storefront B's
 * `/api/auth/get-session`, assert the response is JSON `null` (BA's
 * no-session shape — `node_modules/better-auth/dist/api/routes/session.mjs`
 * `return ctx.json(null)`). The eviction path:
 *
 *   1. BA reads `session_data` cookie (signed/encoded by the shared
 *      `BETTER_AUTH_SECRET`; verifies + decodes successfully because the
 *      secret is the same across all storefronts in this app).
 *   2. `cookieCache.enabled = true` → version-callback gate runs.
 *   3. `versionConfig(session, user)` runs in the READER tenant's
 *      request context → returns reader-tenant's `tenantId`.
 *   4. Cached payload's `version` field is the WRITER tenant's
 *      `tenantId` (stamped at signup time on storefront A). MISMATCH.
 *   5. BA `expireCookie(ctx, ...sessionData)` → falls through past the
 *      cookieCache branch.
 *   6. `internalAdapter.findSession(token)` → wrapped adapter applies
 *      `tenant_id = readerTenantId` predicate (post-DEL-26
 *      session-model-scoped) → cached session row's `tenant_id =
 *      writerTenantId` → no match → returns null.
 *   7. BA `deleteSessionCookie(ctx)` + `ctx.json(null)`. Attacker gets
 *      `null` user, not the source-tenant payload.
 *
 * Tests 2 + 3 ARE the eviction validation — the eviction happens inside
 * BA's route code, before the adapter is hit, so unit tests at the
 * adapter layer can't observe it. The HTTP-replay assertion is the only
 * mechanism that exercises the full chain.
 *
 * Spec: docs/specs/cookie-cache-tenant-version.md AC#6.
 *       docs/specs/food-hall-test-matrix.md (DEL-26 origin spec).
 */

const STOREFRONT_PORT = 3001;
const PIZZA_BRAND_SLUG = 'pizza-express';
const OOMI_TENANT_SLUG = 'oomi-kitchen-test';

function urlFor(slug: string, path: string): string {
  return `http://${slug}.localhost:${STOREFRONT_PORT}${path}`;
}

function originFor(slug: string): string {
  return `http://${slug}.localhost:${STOREFRONT_PORT}`;
}

function nonce(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Sign up via password and return:
 *   - the user id (for afterAll cleanup),
 *   - the raw `Set-Cookie` header values from the response — one entry
 *     per cookie, attributes preserved.
 *
 * `headersArray()` is used (not `headers()`) because BA emits multiple
 * Set-Cookie rows (session token + session data + possibly more) and
 * `headers()` would collapse them with newlines, breaking robust parsing.
 */
async function signupAndCaptureSetCookies(
  request: APIRequestContext,
  storefrontSlug: string,
  email: string,
): Promise<{ userId: string; setCookies: string[] }> {
  const res = await request.post(
    urlFor(storefrontSlug, '/api/auth/sign-up/email'),
    {
      data: { name: 'Cookie Iso Test', email, password: 'cookie-iso-pass-12c' },
      headers: { Origin: originFor(storefrontSlug) },
    },
  );
  expect(
    res.status(),
    `signup at ${storefrontSlug} body: ${await res.text()}`,
  ).toBe(200);

  const setCookies = res
    .headersArray()
    .filter((h) => h.name.toLowerCase() === 'set-cookie')
    .map((h) => h.value);
  expect(
    setCookies.length,
    `no Set-Cookie returned by signup at ${storefrontSlug}`,
  ).toBeGreaterThan(0);

  const [user] = await db
    .select({ id: tenantEndUsers.id })
    .from(tenantEndUsers)
    .where(
      and(eq(tenantEndUsers.email, email), isNull(tenantEndUsers.deletedAt)),
    )
    .limit(1);
  if (!user) {
    throw new Error(`user row not written for ${email} at ${storefrontSlug}`);
  }
  return { userId: user.id, setCookies };
}

/**
 * Compose an HTTP `Cookie:` request header from a list of `Set-Cookie`
 * response values. For each Set-Cookie, the request-side form is just the
 * leading `name=value` token — attributes (Max-Age, Path, Domain, etc.)
 * are response-only. RFC 6265 §5.4.
 */
function setCookiesToCookieHeader(setCookies: string[]): string {
  return setCookies
    .map((sc) => sc.split(';', 1)[0]?.trim() ?? '')
    .filter(Boolean)
    .join('; ');
}

test.describe('cookie isolation across storefronts', () => {
  const userIds: string[] = [];

  test.afterAll(async () => {
    for (const id of userIds) {
      await db.delete(tenantEndUsers).where(eq(tenantEndUsers.id, id));
    }
  });

  test('BA session cookies are Domain-scoped to the exact storefront slug (no wildcard leak) [DEL-26]', async ({
    request,
  }) => {
    const email = `del26-cookie-cfg-${nonce()}@cookie.test`;
    const { userId, setCookies } = await signupAndCaptureSetCookies(
      request,
      PIZZA_BRAND_SLUG,
      email,
    );
    userIds.push(userId);

    const expectedDomain = `${PIZZA_BRAND_SLUG}.localhost`;
    for (const cookie of setCookies) {
      const domainMatch = cookie.match(/Domain=([^;]+)/i);
      if (!domainMatch) {
        // No Domain attribute — defaults to exact origin. AGENTS.md
        // §Gotchas accepts this; it's the default we want.
        continue;
      }
      const domain = domainMatch[1]?.trim().toLowerCase() ?? '';
      // Wildcard guard. AGENTS.md §Gotchas: "use Domain=admin.deliverse.app
      // (NOT .deliverse.app). Wildcard domain leaks cookies between
      // platform and storefronts."
      expect(
        domain.startsWith('.'),
        `cookie has wildcard Domain "${domain}" — would leak across subdomains. Full Set-Cookie: ${cookie}`,
      ).toBe(false);
      // Exact-match guard. The Domain (if present) must be the storefront
      // subdomain itself.
      expect(
        domain,
        `cookie has wrong Domain "${domain}", expected "${expectedDomain}". Full Set-Cookie: ${cookie}`,
      ).toBe(expectedDomain);
    }
  });

  test('cross-tenant cookie replay pizza-express → oomi-kitchen-test returns null user [cookie-cache-tenant-version]', async ({
    request,
  }) => {
    // Writer: pizza-express (Hospitality Group tenant).
    const email = `cct-pizza-${nonce()}@cookie.test`;
    const { userId, setCookies } = await signupAndCaptureSetCookies(
      request,
      PIZZA_BRAND_SLUG,
      email,
    );
    userIds.push(userId);

    // Sanity: signup at the SAME tenant returns the writer's session.
    // This proves the cookies are usable cross-request (rules out a test
    // bug where the replay returns null because the cookies are mangled).
    const samePassRes = await request.get(
      urlFor(PIZZA_BRAND_SLUG, '/api/auth/get-session'),
      { headers: { Cookie: setCookiesToCookieHeader(setCookies) } },
    );
    expect(samePassRes.status()).toBe(200);
    const samePass = (await samePassRes.json()) as {
      user?: { email?: string };
    } | null;
    expect(
      samePass?.user?.email,
      `same-tenant replay at pizza-express must return the writer user — got: ${JSON.stringify(samePass)}`,
    ).toBe(email);

    // Cross-tenant replay: same cookies at OOMI's get-session. The
    // version callback returns OOMI's tenantId; the cached payload's
    // version is pizza-express's tenantId → mismatch → expire → DB
    // lookup → predicate rejects → null user.
    const crossRes = await request.get(
      urlFor(OOMI_TENANT_SLUG, '/api/auth/get-session'),
      { headers: { Cookie: setCookiesToCookieHeader(setCookies) } },
    );
    expect(crossRes.status()).toBe(200);
    const crossBody = await crossRes.json();
    expect(
      crossBody,
      `cross-tenant replay pizza-express → ${OOMI_TENANT_SLUG} must return null — got: ${JSON.stringify(crossBody)}`,
    ).toBeNull();
  });

  test('cross-tenant cookie replay oomi-kitchen-test → pizza-express returns null user [cookie-cache-tenant-version]', async ({
    request,
  }) => {
    // Writer: oomi-kitchen-test (OOMI Kitchen tenant). Same password
    // signup path as the food-hall spec uses for HTTP fast-path tests.
    const email = `cct-oomi-${nonce()}@cookie.test`;
    const { userId, setCookies } = await signupAndCaptureSetCookies(
      request,
      OOMI_TENANT_SLUG,
      email,
    );
    userIds.push(userId);

    // Sanity: same-tenant replay returns the writer's session.
    const samePassRes = await request.get(
      urlFor(OOMI_TENANT_SLUG, '/api/auth/get-session'),
      { headers: { Cookie: setCookiesToCookieHeader(setCookies) } },
    );
    expect(samePassRes.status()).toBe(200);
    const samePass = (await samePassRes.json()) as {
      user?: { email?: string };
    } | null;
    expect(
      samePass?.user?.email,
      `same-tenant replay at ${OOMI_TENANT_SLUG} must return the writer user — got: ${JSON.stringify(samePass)}`,
    ).toBe(email);

    // Cross-tenant replay: same cookies at pizza-express's get-session.
    // Version callback returns pizza-express's tenantId; cached payload's
    // version is OOMI's tenantId → mismatch → expire → DB lookup → predicate
    // rejects → null user.
    const crossRes = await request.get(
      urlFor(PIZZA_BRAND_SLUG, '/api/auth/get-session'),
      { headers: { Cookie: setCookiesToCookieHeader(setCookies) } },
    );
    expect(crossRes.status()).toBe(200);
    const crossBody = await crossRes.json();
    expect(
      crossBody,
      `cross-tenant replay ${OOMI_TENANT_SLUG} → pizza-express must return null — got: ${JSON.stringify(crossBody)}`,
    ).toBeNull();
  });
});
