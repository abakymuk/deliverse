import { type APIRequestContext, expect, test } from '@playwright/test';
import { db } from '@rp/db';
import { tenantEndUsers } from '@rp/db/schema';
import { and, eq, isNull } from 'drizzle-orm';

/**
 * DEL-26 — Cookie isolation across storefronts (AC#6).
 *
 * AC#6 of DEL-26: "Brand cookie-leak tests still pass — cookies scoped to
 * exact storefront slug." That language refers to the cookie's `Domain`
 * attribute: BA's session cookies must be scoped to the storefront's
 * exact subdomain, not a wildcard. A browser then refuses to send the
 * cookie cross-storefront, so cross-brand cookie leak cannot happen in
 * a normal browsing flow.
 *
 * The invariant tested here is the cookie config itself. Sign up at a
 * brand host, inspect every `Set-Cookie` header on the response, and
 * assert:
 *   - No `Domain` attribute is a wildcard (leading `.` — would leak to
 *     subdomains, per AGENTS.md §Gotchas).
 *   - Any explicit `Domain` equals the exact storefront subdomain.
 *   - Absent `Domain` is accepted (default browser behavior scopes the
 *     cookie to the exact origin).
 *
 * One brand-host signup is sufficient to prove the invariant for all
 * storefronts: the BA cookie config (`advanced.cookiePrefix='rp_store'` +
 * `advanced.crossSubDomainCookies.enabled=false` in
 * `packages/auth-core/src/storefront.ts`) is shared across every
 * storefront. Per-storefront re-testing would re-test the same config.
 *
 * Related (out of scope here): the BA-side cross-tenant cookie replay
 * guard. session-model-scoped (post-DEL-26) shipped the schema +
 * SCOPED_MODELS work but `cookieCache` short-circuits BA's `get-session`
 * before the adapter is called, so cross-tenant replay during the
 * cookieCache TTL still returns the source-tenant payload. See
 * `docs/specs/food-hall-test-matrix.md` § Open Questions §2 for the
 * remaining defense-in-depth gap and the planned follow-up.
 *
 * Spec: docs/specs/food-hall-test-matrix.md.
 */

const STOREFRONT_PORT = 3001;
const PIZZA_BRAND_SLUG = 'pizza-express';

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

test.describe('DEL-26 — cookie isolation across storefronts', () => {
  const userIds: string[] = [];

  test.afterAll(async () => {
    for (const id of userIds) {
      await db.delete(tenantEndUsers).where(eq(tenantEndUsers.id, id));
    }
  });

  test('BA session cookies are Domain-scoped to the exact storefront slug (no wildcard leak)', async ({
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
});
