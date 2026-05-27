import { expect, test } from '@playwright/test';
import { db } from '@rp/db';
import {
  storefronts,
  tenantEndUserSessions,
  tenantEndUserVerifications,
  tenantEndUsers,
  tenants,
} from '@rp/db/schema';
import { and, desc, eq, isNull, like } from 'drizzle-orm';

/**
 * DEL-20 / DEL-22 / DEL-23 — Storefront-aware host resolution + tenant-host auth.
 *
 * Tests 1-6 cover DEL-20's 7 ACs (brand-host unchanged, tenant-host stub,
 * reserved/unknown subdomain handling, header-spoof defense).
 *
 * Tests 7-10 cover the tenant-host auth flow:
 *   - 7: tenant-host password signup → user + session.currentBrandId NULL.
 *   - 8: tenant-host OTP request → verification row brandId NULL.
 *   - 9: tenant-host OTP signup completes end-to-end (DEL-23). Skips when
 *        Inngest dev (:8288) is unreachable; fails if reachable but the
 *        OTP event never arrives.
 *   - 10: tenant-host password reset → 200 (Inngest payload + URL rewrite
 *         covered by @rp/emails unit tests).
 *
 * Fixture: DEL-25 promoted `oomi-kitchen-test` to canonical seed (it's the
 * food-hall demo tenant). The `beforeAll` block here is defensive — its
 * inserts are `onConflictDoNothing` so they no-op when canonical seed has
 * already provisioned OOMI Kitchen, and they fully seed OOMI if (for any
 * reason) the canonical seed wasn't run. `afterAll` no longer cascade-
 * deletes the tenant (that would wipe canonical seed data); it does a
 * targeted cleanup of just the tenant_end_users created by tests 7-10.
 *
 * Specs:
 *   - docs/specs/storefront-host-resolution.md  (DEL-20)
 *   - docs/specs/ba-brand-optional.md           (DEL-22)
 *   - docs/specs/verification-brand-optional.md (DEL-23)
 */

const STOREFRONT_PORT = 3001;
const PIZZA_BRAND_SLUG = 'pizza-express';
const OOMI_TENANT_SLUG = 'oomi-kitchen-test';
const OOMI_STOREFRONT_SLUG = 'oomi-kitchen-test';
const RESERVED_SUBDOMAIN = 'admin';
const UNKNOWN_SUBDOMAIN = 'nonexistent';

const INNGEST_DEV_URL = 'http://localhost:8288/v1/events';

function urlFor(slug: string, path: string): string {
  return `http://${slug}.localhost:${STOREFRONT_PORT}${path}`;
}

/**
 * Result of polling Inngest dev for an OTP event.
 *
 * `unreachable` — Inngest dev not running on :8288 (e.g., CI without
 *   `inngest-cli dev`). Caller should `test.skip()`.
 * `timeout` — Inngest reachable but matching event never appeared. Caller
 *   should THROW — signals a real regression in the BA `sendVerificationOTP`
 *   callback or the Inngest emit path.
 * `found` — plaintext OTP extracted from the event payload.
 */
type OtpPollResult =
  | { status: 'found'; otp: string }
  | { status: 'unreachable' }
  | { status: 'timeout' };

/**
 * Poll Inngest dev tools for the latest `email.otp.requested` event whose
 * `data.email` matches `email`.
 *
 * BA stores OTPs hashed (`storeOTP: 'hashed'` in storefront.ts), so the
 * plaintext lives only in the Inngest event payload. Per-memory Inngest
 * indexing lag is 10-30s; default deadline 30s.
 *
 * Spec: docs/specs/verification-brand-optional.md (DEL-23).
 */
async function pollInngestDevForOtp(
  email: string,
  deadlineMs = 30_000,
): Promise<OtpPollResult> {
  // Probe once to distinguish unreachable from timeout.
  try {
    const probe = await fetch(`${INNGEST_DEV_URL}?event=email.otp.requested&limit=1`);
    if (!probe.ok) return { status: 'unreachable' };
  } catch {
    return { status: 'unreachable' };
  }

  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${INNGEST_DEV_URL}?event=email.otp.requested&limit=20`);
      if (!res.ok) return { status: 'unreachable' };
      const json = (await res.json()) as {
        data?: Array<{ data?: { email?: string; otp?: string } }>;
      };
      const match = json.data?.find((e) => e.data?.email === email);
      if (match?.data?.otp) return { status: 'found', otp: match.data.otp };
    } catch {
      // Network or JSON parse hiccup during polling — treat as unreachable,
      // do NOT crash the test. Probe above confirmed initial reachability;
      // this catches transient failures.
      return { status: 'unreachable' };
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return { status: 'timeout' };
}

// Serial: shared beforeAll/afterAll fixture (OOMI Kitchen Test tenant + storefront).
// Mirrors the storefront-tenant-scoping.spec.ts serialization rationale —
// parallel workers would race teardown.
test.describe
  .serial('DEL-20 — storefront-aware host resolution', () => {
    let oomiTenantId: string;

    test.beforeAll(async () => {
      await db
        .insert(tenants)
        .values({ slug: OOMI_TENANT_SLUG, name: 'OOMI Kitchen Test', status: 'active' })
        .onConflictDoNothing();

      const [tenantRow] = await db
        .select({ id: tenants.id })
        .from(tenants)
        .where(and(eq(tenants.slug, OOMI_TENANT_SLUG), isNull(tenants.deletedAt)))
        .limit(1);
      if (!tenantRow) throw new Error(`tenant ${OOMI_TENANT_SLUG} not created`);
      oomiTenantId = tenantRow.id;

      await db
        .insert(storefronts)
        .values({
          tenantId: oomiTenantId,
          slug: OOMI_STOREFRONT_SLUG,
          name: 'OOMI Kitchen Test',
          type: 'tenant',
          primaryBrandId: null,
          brandingJson: {},
          isActive: true,
        })
        .onConflictDoNothing();
    });

    test.afterAll(async () => {
      // DEL-25: do NOT cascade-delete the OOMI tenant — it's canonical seed
      // data now. Cleanup is targeted to just the tenant_end_users created
      // by tests 7-10 (they own the `@smoke.local` email suffix). Session +
      // verification rows cascade off the user via FK ON DELETE CASCADE.
      await db
        .delete(tenantEndUsers)
        .where(
          and(
            eq(tenantEndUsers.tenantId, oomiTenantId),
            like(tenantEndUsers.email, '%@smoke.local'),
          ),
        );
    });

    test('1. brand host renders existing home with brand heading (AC#5)', async ({
      request,
    }) => {
      const res = await request.get(urlFor(PIZZA_BRAND_SLUG, '/'));
      expect(res.status()).toBe(200);
      const body = await res.text();
      expect(body).toContain('Pizza Express');
    });

    test('2. tenant host renders food-hall directory with brand cards (DEL-25)', async ({
      request,
    }) => {
      // DEL-25 replaced the food-hall stub with a brand directory. The
      // OOMI tenant's canonical seed includes OOMI Burger + OOMI Pizza
      // brands served by the `oomi-kitchen` location; both cards should
      // render. "OOMI Kitchen" substring matches both the canonical
      // em-dash name ("OOMI Kitchen — Test") and the test fixture's
      // plain name ("OOMI Kitchen Test") — defensive against which one
      // populated the storefront row first.
      const res = await request.get(urlFor(OOMI_STOREFRONT_SLUG, '/'));
      expect(res.status()).toBe(200);
      const body = await res.text();
      expect(body).toContain('OOMI Kitchen');
      expect(body).toContain('Choose a brand to start your order');
      expect(body).toContain('OOMI Burger');
      expect(body).toContain('OOMI Pizza');
    });

    test('3. reserved subdomain bypasses storefront resolution (AC#7)', async ({ request }) => {
      const res = await request.get(urlFor(RESERVED_SUBDOMAIN, '/'));
      expect(res.status()).toBe(200);
      // Dev-helpful message, unchanged from pre-DEL-20.
      expect(await res.text()).toContain('No brand specified');
    });

    test('4. unknown subdomain returns 404', async ({ request }) => {
      const res = await request.get(urlFor(UNKNOWN_SUBDOMAIN, '/'));
      expect(res.status()).toBe(404);
    });

    test('5. brand-host header-spoof: client-supplied x-storefront-type is stripped, brand UI renders', async ({
      request,
    }) => {
      const res = await request.get(urlFor(PIZZA_BRAND_SLUG, '/'), {
        headers: {
          'x-storefront-type': 'tenant',
          'x-storefront-name': 'Evil Hall',
        },
      });
      expect(res.status()).toBe(200);
      const body = await res.text();
      expect(body).toContain('Pizza Express');
      expect(body).not.toContain('Evil Hall');
      // DEL-25 replaced the food-hall stub with a directory; the new
      // tenant-mode UI signal is the "Choose a brand" intro copy.
      expect(body).not.toContain('Choose a brand to start your order');
    });

    test('6. unknown-host header-spoof: stripped headers, page 404s (critical strip-before-branch case)', async ({
      request,
    }) => {
      const res = await request.get(urlFor(UNKNOWN_SUBDOMAIN, '/'), {
        headers: {
          'x-storefront-type': 'tenant',
          'x-storefront-name': 'Evil Hall',
        },
      });
      expect(res.status()).toBe(404);
    });

    // ── DEL-22 tenant-host auth flows ──────────────────────────────────────
    //
    // These three tests share a single test-scoped user (created in test 7's
    // signup, exercised by tests 8 and 9). They assert HTTP 200 + DB effects
    // only — Inngest event payload shape is covered by `@rp/emails` unit tests.
    // The OOMI Kitchen Test fixture from `beforeAll` is the storefront these
    // requests resolve to.

    const tenantUserEmail = `del22-tenant-${Date.now()}@smoke.local`;
    const tenantUserPassword = 'tenant-pass-12chars';
    // DEL-23: separate email for the OTP-signup pair (tests 8 + 9) so it's
    // independent of test 7's password-signup user (which test 10 needs).
    const otpSignupEmail = `del23-otp-${Date.now()}@smoke.local`;
    const oomiOrigin = `http://${OOMI_STOREFRONT_SLUG}.localhost:${STOREFRONT_PORT}`;
    let tenantEndUserId: string;

    test('7. tenant-host password signup creates user + session with currentBrandId NULL (DEL-22)', async ({
      request,
    }) => {
      const res = await request.post(urlFor(OOMI_STOREFRONT_SLUG, '/api/auth/sign-up/email'), {
        data: { name: 'DEL-22 tenant smoke', email: tenantUserEmail, password: tenantUserPassword },
        headers: { Origin: oomiOrigin },
      });
      expect(res.status(), `tenant-host signup body: ${await res.text()}`).toBe(200);

      const [user] = await db
        .select({ id: tenantEndUsers.id, tenantId: tenantEndUsers.tenantId })
        .from(tenantEndUsers)
        .where(and(eq(tenantEndUsers.email, tenantUserEmail), isNull(tenantEndUsers.deletedAt)))
        .limit(1);
      if (!user) throw new Error(`user row not written for ${tenantUserEmail}`);
      expect(user.tenantId).toBe(oomiTenantId);
      tenantEndUserId = user.id;

      const [session] = await db
        .select({ currentBrandId: tenantEndUserSessions.currentBrandId })
        .from(tenantEndUserSessions)
        .where(eq(tenantEndUserSessions.tenantEndUserId, user.id))
        .orderBy(desc(tenantEndUserSessions.createdAt))
        .limit(1);
      if (!session) throw new Error('session row not written for tenant-host signup');
      // DEL-22 + DEL-21: tenant-host sessions stamp NULL.
      expect(session.currentBrandId).toBeNull();
    });

    test('8. tenant-host OTP request writes verification row with brandId NULL (DEL-22)', async ({
      request,
    }) => {
      // DEL-23: uses otpSignupEmail (separate from test-7 password user) so
      // tests 8+9 form an independent OTP-signup pair, and test 10 keeps
      // tenantUserEmail (the password-signup user) for password reset.
      if (!tenantEndUserId) {
        throw new Error('test 7 must run before test 8 — describe.serial is required');
      }
      const res = await request.post(
        urlFor(OOMI_STOREFRONT_SLUG, '/api/auth/email-otp/send-verification-otp'),
        {
          data: { email: otpSignupEmail, type: 'sign-in' },
          headers: { Origin: oomiOrigin },
        },
      );
      expect(res.status(), `tenant-host OTP body: ${await res.text()}`).toBe(200);

      const [verification] = await db
        .select({
          tenantId: tenantEndUserVerifications.tenantId,
          brandId: tenantEndUserVerifications.brandId,
        })
        .from(tenantEndUserVerifications)
        .where(eq(tenantEndUserVerifications.identifier, `sign-in-otp-${otpSignupEmail}`))
        .orderBy(desc(tenantEndUserVerifications.createdAt))
        .limit(1);
      if (!verification) throw new Error('verification row not written for tenant-host OTP');
      expect(verification.tenantId).toBe(oomiTenantId);
      // DEL-22 adapter `ctx.brandId ?? null` — tenant-host verifications stamp NULL.
      expect(verification.brandId).toBeNull();
    });

    test('9. tenant-host OTP signup completes end-to-end via Inngest dev (DEL-23)', async ({
      request,
    }) => {
      // Polls the Inngest event that test 8 just emitted (describe.serial
      // guarantees ordering within seconds). BA stores OTPs hashed; plaintext
      // lives only in the Inngest event payload. See
      // docs/specs/verification-brand-optional.md.
      const poll = await pollInngestDevForOtp(otpSignupEmail, 30_000);
      if (poll.status === 'unreachable') {
        test.skip(
          true,
          'Inngest dev (:8288) not running — see AGENTS.md Gotchas. Start `inngest-cli dev` to run this assertion.',
        );
        return;
      }
      if (poll.status === 'timeout') {
        throw new Error(
          `OTP event not found in Inngest dev within 30s — flow broke. tenant=${oomiTenantId} email=${otpSignupEmail}`,
        );
      }
      const { otp } = poll;

      // Body shape mirrors `signIn.emailOtp({ email, otp, name? })` from
      // verify-otp-form.tsx:67-71. `name` is required for first-time signup;
      // BA's emailOTP plugin uses it ONLY when creating a new user.
      const signInRes = await request.post(
        urlFor(OOMI_STOREFRONT_SLUG, '/api/auth/sign-in/email-otp'),
        {
          data: { email: otpSignupEmail, otp, name: 'DEL-23 OTP smoke' },
          headers: { Origin: oomiOrigin },
        },
      );
      expect(
        signInRes.status(),
        `sign-in/email-otp body: ${await signInRes.text()}`,
      ).toBe(200);

      // Session cookie set with the storefront BA cookie prefix (DEL-17 fix).
      const setCookie = signInRes.headers()['set-cookie'] ?? '';
      expect(setCookie).toContain('rp_store');

      // OTP-signup created a new user on the OOMI tenant. The new session is
      // tenant-mode: currentBrandId NULL.
      const [user] = await db
        .select({ id: tenantEndUsers.id, tenantId: tenantEndUsers.tenantId })
        .from(tenantEndUsers)
        .where(and(eq(tenantEndUsers.email, otpSignupEmail), isNull(tenantEndUsers.deletedAt)))
        .limit(1);
      if (!user) throw new Error('user row not created after OTP signup');
      expect(user.tenantId).toBe(oomiTenantId);

      const [session] = await db
        .select({ currentBrandId: tenantEndUserSessions.currentBrandId })
        .from(tenantEndUserSessions)
        .where(eq(tenantEndUserSessions.tenantEndUserId, user.id))
        .orderBy(desc(tenantEndUserSessions.createdAt))
        .limit(1);
      if (!session) throw new Error('session row not written after OTP sign-in');
      expect(session.currentBrandId).toBeNull();
    });

    test('10. tenant-host password reset request returns 200 for existing user (DEL-22)', async ({
      request,
    }) => {
      if (!tenantEndUserId) {
        throw new Error('test 7 must run before test 10 — describe.serial is required');
      }
      // BA 1.6.x exposes the sendResetPassword callback via `/request-password-reset`
      // (verified at node_modules/better-auth/.../api/routes/password.mjs:20).
      const res = await request.post(
        urlFor(OOMI_STOREFRONT_SLUG, '/api/auth/request-password-reset'),
        {
          data: {
            email: tenantUserEmail,
            redirectTo: `${oomiOrigin}/reset-password`,
          },
          headers: { Origin: oomiOrigin },
        },
      );
      expect(res.status(), `tenant-host password-reset body: ${await res.text()}`).toBe(200);
      // The Inngest event payload (mode: 'tenant', storefrontId/storefrontSlug)
      // and the URL rewrite to oomi-kitchen-test.* are covered by @rp/emails
      // unit tests. This e2e asserts the callback executes without throwing
      // — i.e., the resolver doesn't 400 on absent brandId (AC#4).
    });
  });
