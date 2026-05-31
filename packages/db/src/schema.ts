/**
 * ============================================================================
 * AUTH SCHEMA — packages/db/src/schema.ts
 * ============================================================================
 *
 * Two Better-Auth instances:
 *   - Platform (apps/platform) uses *platform_* tables
 *   - Storefront (apps/storefront) uses *tenant_end_user_* tables
 *
 * Tenant domain (tenants, locations, brands) is shared.
 *
 * KEY INVARIANTS:
 *   1. platform_users.email is GLOBALLY unique (among non-deleted)
 *   2. tenant_end_users.email is unique PER TENANT (not globally)
 *   3. All FKs cascade properly on tenant deletion
 *   4. Sessions and verifications are completely separated by app
 *
 * BETTER-AUTH CONVENTIONS USED:
 *   - Maps our custom table names to BA's expected "user", "session",
 *     "account", "verification" models via fields config (see auth.ts)
 *   - Uses Organization plugin for tenant memberships
 *   - Uses Email OTP plugin for storefront passwordless flow
 * ============================================================================
 */

import {
  check,
  pgTable,
  uuid,
  text,
  timestamp,
  boolean,
  integer,
  jsonb,
  pgEnum,
  uniqueIndex,
  index,
  primaryKey,
} from 'drizzle-orm/pg-core';
import { sql, relations } from 'drizzle-orm';
import type { ModifierSnapshot } from './modifier-snapshot';

// ============================================================================
// ENUMS
// ============================================================================
//
// Why Postgres enums (not text + check constraint)?
//   - Type safety in Drizzle (compile-time check on values)
//   - Better performance (4-byte enum vs variable text)
//   - Self-documenting in DB schema (psql \dT+ shows allowed values)
//   - Migration discipline: adding values requires explicit migration
//
// Why these specific values?
//   - tenant_status: lifecycle states (active → suspended → pending_deletion)
//     "pending_deletion" enables 30-day grace period before hard delete
//   - tenant_role: hierarchy from owner (full access) down to viewer (read-only)
//   - verification_type: covers all auth flows that issue a token

export const tenantStatusEnum = pgEnum('tenant_status', [
  'active',
  'suspended',
  'pending_deletion',
]);

export const tenantRoleEnum = pgEnum('tenant_role', [
  'owner',
  'manager',
  'staff',
  'viewer',
]);

export const verificationTypeEnum = pgEnum('verification_type', [
  'otp_login',        // 6-digit code for passwordless login (end users)
  'email_verify',     // confirm email address on signup
  'password_reset',   // password reset link (platform users + end users w/ password)
]);

// DEL-19: storefront-type discriminator.
//   'brand'  → single-brand storefront. Has primary_brand_id; routes
//              currently match brands.slug (DEL-20 swaps the lookup).
//   'tenant' → tenant-level (food-hall) storefront. No primary_brand_id;
//              hosts many brands behind one URL (DEL-25 builds the UX).
// CHECK constraint on the table enforces "type='brand' ⟺ primary_brand_id NOT NULL".
export const storefrontTypeEnum = pgEnum('storefront_type', ['brand', 'tenant']);

// DEL-24: commerce schema enums (ADR-0012 §"Commerce model").
//
// Cart lifecycle. 'active' = open; 'abandoned' = user moved on without
// checkout (status-flip via cleanup job, v2); 'converted' = cart became
// an order.
export const cartStatusEnum = pgEnum('cart_status', [
  'active',
  'abandoned',
  'converted',
]);

// DEL-34 / X3: modifier group selection mode. 'single' = pick exactly one
// (radio); 'multi' = pick zero-to-many (checkboxes), bounded by min/max_select.
export const modifierSelectionTypeEnum = pgEnum('modifier_selection_type', [
  'single',
  'multi',
]);

// DEL-32 / X1: the old single `order_status` enum conflated customer intent
// with kitchen fulfillment. It is split into the two machines below —
// `order_intent_status` (intent) + `fulfillment_status` (per-brand ticket).
// The old `order_status` enum + `orders` table are removed in migration 0011.

// Intent lifecycle — what the customer committed to. Intent-only; never
// carries kitchen states.
export const orderIntentStatusEnum = pgEnum('order_intent_status', [
  'placed',
  'cancelled',
]);

// Per-(intent, brand) fulfillment lifecycle — the KDS ticket. The kitchen
// half of the old order_status enum; X6 (KDS) drives the transitions. The
// canonical transition map + validator live in ./fulfillment-status.ts.
export const fulfillmentStatusEnum = pgEnum('fulfillment_status', [
  'queued',
  'preparing',
  'ready',
  'completed',
  'cancelled',
]);

// Actor identity for audit / agent telemetry (DEL-33 / X2). Declared in the
// EXACT order of @rp/events `actorType` (packages/events/src/schema.ts): a
// pgEnum's declaration order is its sort order, and a parity test in
// @rp/events asserts the two lists stay identical.
export const actorTypeEnum = pgEnum('actor_type', [
  'tenant_end_user',
  'platform_user',
  'service_account',
  'agent',
  'system',
]);

// Fulfillment type, orthogonal to status. Status describes the lifecycle;
// fulfillment_type describes pickup vs delivery vs dine-in. Used by carts +
// order_fulfillments. 'dine_in' added in DEL-32 / X1.
export const fulfillmentTypeEnum = pgEnum('fulfillment_type', [
  'pickup',
  'delivery',
  'dine_in',
]);

// Payment + refund lifecycle (DEL-35 / X4). Provider-agnostic (Stripe is the
// only provider at launch). partially_refunded/refunded are driven by the
// refund webhook reconciling sum(refunds.amount_cents) vs payments.amount_cents.
export const paymentStatusEnum = pgEnum('payment_status', [
  'pending',
  'captured',
  'partially_refunded',
  'refunded',
  'failed',
  'canceled',
]);

export const refundStatusEnum = pgEnum('refund_status', [
  'pending',
  'succeeded',
  'failed',
  'canceled',
]);

// ============================================================================
// PLATFORM IDENTITY (apps/platform)
// ============================================================================
//
// Used by: staff (your team) and tenant members (restaurant operators).
// Single identity space — same person can be both, distinguished by
// tenant_memberships role.

/**
 * platform_users — staff + tenant members
 *
 * Better-Auth maps this as "user" model in platform instance.
 */
export const platformUsers = pgTable('platform_users', {
  // UUID over serial:
  //   - No leaky info (count of users from /users/123)
  //   - Safe to expose in URLs
  //   - Distributed-system friendly (no centralized counter)
  //   - 16 bytes vs 8, but with B-tree index the cost is negligible at scale
  id: uuid('id').primaryKey().defaultRandom(),

  // Email: identifier + recovery. Globally unique among non-deleted.
  email: text('email').notNull(),

  // Display name. Required by Better-Auth core (user.name).
  // Signup paths supply a fallback (e.g. email local-part) when OAuth omits it.
  name: text('name').notNull(),

  // Better-Auth core shape: boolean, default false, input:false.
  // Audit "when did they verify?" is a v2 concern — add a separate
  // email_verified_at column + databaseHooks.user.update.after if needed.
  emailVerified: boolean('email_verified').notNull().default(false),

  // Profile image URL (from OAuth provider or user upload).
  imageUrl: text('image_url'),

  // Audit timestamps — required for any production table.
  // withTimezone: true → stored as TIMESTAMPTZ, avoids the worst class of bugs.
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),

  // Soft delete. Why not hard delete?
  //   - GDPR audit trail (when did user disappear?)
  //   - Accidental deletion recovery within grace period
  //   - Analytics on churn require historical data
  // Null = active; timestamp = soft-deleted at that moment.
  // Hard delete runs as scheduled job after retention period.
  deletedAt: timestamp('deleted_at', { withTimezone: true }),

  // DEL-46: distinguishes internal platform staff (global operators who may act
  // on any tenant) from external tenant operators. requireTenantAccess reads this
  // fresh from the DB for money/Connect actions (apps/platform/src/lib/authz.ts).
  isPlatformStaff: boolean('is_platform_staff').notNull().default(false),
}, (t) => ({
  // PARTIAL UNIQUE INDEX:
  // Email unique only among non-deleted users.
  // Why: if user X soft-deleted, user Y should be able to sign up
  // with same email. Hard requirement for "delete my account" UX.
  emailIdx: uniqueIndex('platform_users_email_idx')
    .on(t.email)
    .where(sql`${t.deletedAt} IS NULL`),
}));

/**
 * platform_accounts — credentials attached to platform users
 *
 * One user can have multiple accounts: one for password, one for Google.
 * Better-Auth maps this as "account" model in platform instance.
 *
 * Why separate from user table?
 *   - User identity stays clean (one row per person)
 *   - Credentials can be added/removed without touching user record
 *   - Account linking (password + Google) is just multiple rows
 *   - Better-Auth pattern, optimized for OAuth linking
 */
export const platformAccounts = pgTable('platform_accounts', {
  id: uuid('id').primaryKey().defaultRandom(),

  // FK to platform_users.
  // onDelete cascade: if user soft-deleted then hard-deleted, accounts go too.
  platformUserId: uuid('platform_user_id')
    .notNull()
    .references(() => platformUsers.id, { onDelete: 'cascade' }),

  // Provider: "credentials" (email+password) or "google" (OAuth).
  // We use text not enum here for flexibility — BA may add providers,
  // we don't want migration for each new one.
  providerId: text('provider_id').notNull(),

  // Provider's account identifier:
  //   - For credentials: user's email (matches platform_users.email)
  //   - For google: Google's user ID (sub claim from JWT)
  accountId: text('account_id').notNull(),

  // For password auth: bcrypt hash. NULL for OAuth-only accounts.
  // Bcrypt cost ≥12 (set in BA config, not here).
  // Never log this field. Never include in API responses.
  password: text('password'),

  // OAuth tokens — only populated for OAuth providers.
  accessToken: text('access_token'),
  refreshToken: text('refresh_token'),
  idToken: text('id_token'),
  accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }),
  refreshTokenExpiresAt: timestamp('refresh_token_expires_at', { withTimezone: true }),
  scope: text('scope'),  // OAuth scopes granted

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  // One account per (provider, accountId) — no duplicates.
  // E.g., one Google account can only link to one platform_user.
  providerAccountIdx: uniqueIndex('platform_accounts_provider_account_idx')
    .on(t.providerId, t.accountId),

  // Frequent query: "all accounts for this user" (e.g., on settings page)
  userIdx: index('platform_accounts_user_idx').on(t.platformUserId),
}));

/**
 * platform_sessions — active login sessions for platform users
 *
 * Better-Auth maps this as "session" model in platform instance.
 *
 * Why a sessions table (not JWT-only)?
 *   - Revocation: "logout all devices" is a single DELETE
 *   - Visibility: "your active sessions" UI works
 *   - Security: compromised token can be invalidated server-side
 *   - JWT-only is faster but can't be revoked until expiry
 */
export const platformSessions = pgTable('platform_sessions', {
  id: uuid('id').primaryKey().defaultRandom(),

  platformUserId: uuid('platform_user_id')
    .notNull()
    .references(() => platformUsers.id, { onDelete: 'cascade' }),

  // The opaque token sent to client (in cookie).
  // Better-Auth handles generation. Stored hashed in some BA configs;
  // default is plaintext-equivalent (random bytes, no entropy concern).
  token: text('token').notNull(),

  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),

  // Forensics: where did this session come from?
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),

  // Better-Auth organization plugin augments session with activeOrganizationId.
  // Nullable: a session exists before any tenant is selected.
  // ON DELETE SET NULL: tenant hard-delete leaves the session valid but unscoped.
  activeOrganizationId: uuid('active_organization_id')
    .references(() => tenants.id, { onDelete: 'set null' }),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  // Hot path: lookup session by token on every request
  tokenIdx: uniqueIndex('platform_sessions_token_idx').on(t.token),

  // For "logout all devices" and session listing
  userIdx: index('platform_sessions_user_idx').on(t.platformUserId),

  // For periodic cleanup of expired sessions (cron job)
  expiresIdx: index('platform_sessions_expires_idx').on(t.expiresAt),

  // "List sessions in this org" — admin UI, audit, tenant-member-removed cleanup.
  activeOrgIdx: index('platform_sessions_active_org_idx').on(t.activeOrganizationId),
}));

/**
 * platform_verifications — short-lived tokens (password reset, email verify)
 *
 * Better-Auth maps this as "verification" model in platform instance.
 * Platform doesn't use OTP, so this is mostly for email verify + password reset.
 */
export const platformVerifications = pgTable('platform_verifications', {
  id: uuid('id').primaryKey().defaultRandom(),

  // Identifier: usually the email being verified
  identifier: text('identifier').notNull(),

  // The token sent to user (in email link or 6-digit code).
  // STORED HASHED — never plaintext.
  // If DB is dumped, attacker can't replay tokens.
  value: text('value').notNull(),

  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  // Lookup: "is this token valid for this identifier?"
  identifierIdx: index('platform_verifications_identifier_idx').on(t.identifier),

  // Cleanup expired
  expiresIdx: index('platform_verifications_expires_idx').on(t.expiresAt),
}));

// ============================================================================
// TENANT DOMAIN (shared between platform and storefront)
// ============================================================================

/**
 * tenants — business entity, billing unit
 *
 * Better-Auth's organization plugin maps this as "organization" model.
 * BA expects fields: id, name, slug, logo, metadata, createdAt.
 * We add more (status, deletedAt) for business logic.
 */
export const tenants = pgTable('tenants', {
  id: uuid('id').primaryKey().defaultRandom(),

  // Used in URLs and for tenant lookup. UNIQUE globally.
  // Constraints: lowercase, alphanumeric + hyphens, 3-50 chars.
  // Validation in app layer, DB just ensures uniqueness.
  slug: text('slug').notNull(),

  // Display name (e.g., "Hospitality Group LLC")
  name: text('name').notNull(),

  // Logo URL — required by BA organization plugin
  logo: text('logo'),

  // Lifecycle status. See enum comments above.
  status: tenantStatusEnum('status').notNull().default('active'),

  // Flexible metadata — BA expects "metadata" field.
  // We use jsonb for query-ability (vs json which is plain text in postgres).
  metadata: jsonb('metadata').$type<Record<string, unknown>>(),

  // Stripe Connect (DEL-35 / X4). account_id is set when onboarding STARTS so
  // re-clicks reuse the same Express account (no duplicates); charges_enabled
  // is flipped by the account.updated webhook once Stripe verifies the account.
  // The future charge path gates on charges_enabled, NOT on account_id presence.
  stripeAccountId: text('stripe_account_id'),
  stripeChargesEnabled: boolean('stripe_charges_enabled').notNull().default(false),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
}, (t) => ({
  // Slug unique among active tenants
  slugIdx: uniqueIndex('tenants_slug_idx')
    .on(t.slug)
    .where(sql`${t.deletedAt} IS NULL`),

  // Status queries (e.g., "find all pending_deletion")
  statusIdx: index('tenants_status_idx').on(t.status),
}));

/**
 * locations — physical kitchens
 *
 * One tenant has N locations. A location can serve multiple brands
 * (dark kitchen pattern via location_brands join table).
 */
export const locations = pgTable('locations', {
  id: uuid('id').primaryKey().defaultRandom(),

  // Owner tenant. Cascade delete: kill tenant → kill locations.
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' }),

  name: text('name').notNull(),  // e.g., "Kitchen on 5th Ave"
  addressLine1: text('address_line1').notNull(),
  addressLine2: text('address_line2'),
  city: text('city').notNull(),
  state: text('state').notNull(),
  postalCode: text('postal_code').notNull(),
  country: text('country').notNull(),

  // Lat/lng for distance queries (delivery radius, etc.)
  // Stored as numeric for precision; alternative is PostGIS for spatial ops.
  latitude: text('latitude'),   // decimal text for precision
  longitude: text('longitude'),

  // Operational status (open, closed, temp_closed)
  isActive: boolean('is_active').notNull().default(true),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
}, (t) => ({
  tenantIdx: index('locations_tenant_idx').on(t.tenantId),
}));

/**
 * brands — customer-facing identity
 *
 * Each brand has its own subdomain, branding, customers.
 * One tenant owns N brands. A brand belongs to exactly one tenant.
 *
 * End users are scoped to TENANT (not brand) — see tenant_end_users.
 * But brand provides the contextual frame (subdomain, theme, OTP email branding).
 */
export const brands = pgTable('brands', {
  id: uuid('id').primaryKey().defaultRandom(),

  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' }),

  // Used for subdomain: {slug}.deliverse.app
  // Globally unique (not just per-tenant) because subdomains are global.
  slug: text('slug').notNull(),

  name: text('name').notNull(),

  // Theming: colors, fonts, logo URL, etc.
  // Stored as jsonb so we can extend without migration each time.
  // Example: { primary: "#FF0000", logo: "...", font: "Inter" }
  brandingJson: jsonb('branding_json').$type<BrandBranding>().notNull().default({}),

  isActive: boolean('is_active').notNull().default(true),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
}, (t) => ({
  // Slug globally unique among active brands (drives subdomain routing)
  slugIdx: uniqueIndex('brands_slug_idx')
    .on(t.slug)
    .where(sql`${t.deletedAt} IS NULL`),

  tenantIdx: index('brands_tenant_idx').on(t.tenantId),
}));

/**
 * location_brands — M:N join for dark kitchen pattern
 *
 * One location can serve N brands; one brand can be served by N locations.
 * Composite PK = no duplicates.
 */
export const locationBrands = pgTable('location_brands', {
  locationId: uuid('location_id')
    .notNull()
    .references(() => locations.id, { onDelete: 'cascade' }),

  brandId: uuid('brand_id')
    .notNull()
    .references(() => brands.id, { onDelete: 'cascade' }),

  // When this brand started serving from this location (for audit/analytics)
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  pk: primaryKey({ columns: [t.locationId, t.brandId] }),
  // Reverse lookup: "which locations serve this brand?"
  brandIdx: index('location_brands_brand_idx').on(t.brandId),
}));

/**
 * storefronts — customer-facing entry points (DEL-19 / ADR-0012)
 *
 * Storefront ≠ brand. A storefront is a URL/shell that may host one brand
 * (type='brand', current default — what `{brand}.deliverse.app` resolves
 * to today) or many brands (type='tenant', food-hall mode shipped by
 * DEL-25). Backfill from DEL-19 migration creates one row per LIVE brand
 * with type='brand', primary_brand_id=brand.id, slug=brand.slug.
 *
 * DEL-19 is additive only — application code still routes via brands.slug.
 * DEL-20 switches the storefront proxy/resolver onto this table.
 *
 * Spec: docs/specs/storefronts-model.md.
 * ADR:  docs/decisions/0012-storefront-brand-tenant-food-hall-architecture.md.
 */
export const storefronts = pgTable('storefronts', {
  id: uuid('id').primaryKey().defaultRandom(),

  // Owner tenant. Cascade delete: kill tenant → kill its storefronts.
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' }),

  // Subdomain. Partial-unique among active rows (mirrors brands.slug).
  // Drives the future host → storefront lookup in DEL-20+.
  slug: text('slug').notNull(),

  name: text('name').notNull(),

  // Discriminator. CHECK constraint below enforces:
  //   type='brand'  ⟹  primary_brand_id NOT NULL
  //   type='tenant' ⟹  primary_brand_id IS NULL
  type: storefrontTypeEnum('type').notNull(),

  // Required when type='brand', NULL when type='tenant'. DEL-19 backfill
  // sets this for every live brand; later admin paths can add or
  // re-target.
  primaryBrandId: uuid('primary_brand_id')
    .references(() => brands.id, { onDelete: 'cascade' }),

  // Branding overrides (color, logo URL, etc.). Backfill copies the
  // brand's branding_json once; no sync mechanism in v1 — see spec.
  brandingJson: jsonb('branding_json').$type<BrandBranding>().notNull().default({}),

  isActive: boolean('is_active').notNull().default(true),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
}, (t) => ({
  // Subdomain partial-unique among active rows (matches brands.slug pattern).
  slugIdx: uniqueIndex('storefronts_slug_idx')
    .on(t.slug)
    .where(sql`${t.deletedAt} IS NULL`),

  // "All storefronts of this tenant" — admin UI.
  tenantIdx: index('storefronts_tenant_idx').on(t.tenantId),

  // "Find the storefront for this brand" — DEL-20+ resolves brand-host
  // requests by primary_brand_id during the transitional period.
  primaryBrandIdx: index('storefronts_primary_brand_idx').on(t.primaryBrandId),

  // Defense-in-depth: app-layer should also validate, but the DB makes
  // the (type, primary_brand_id) invariant impossible to break.
  primaryBrandCheck: check(
    'storefronts_type_primary_brand_check',
    sql`(${t.type} = 'brand' AND ${t.primaryBrandId} IS NOT NULL) OR (${t.type} = 'tenant' AND ${t.primaryBrandId} IS NULL)`,
  ),
}));

/**
 * tenant_memberships — platform_users × tenants with role
 *
 * Better-Auth organization plugin maps this as "member" model.
 * BA expects: id, organizationId, userId, role, createdAt.
 */
export const tenantMemberships = pgTable('tenant_memberships', {
  id: uuid('id').primaryKey().defaultRandom(),

  // FK to platform_users
  platformUserId: uuid('platform_user_id')
    .notNull()
    .references(() => platformUsers.id, { onDelete: 'cascade' }),

  // FK to tenants
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' }),

  role: tenantRoleEnum('role').notNull(),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  // One membership per (user, tenant) — can't be member twice
  uniqueMembership: uniqueIndex('tenant_memberships_user_tenant_idx')
    .on(t.platformUserId, t.tenantId),

  // Lookup: "all members of this tenant" (e.g., tenant settings page)
  tenantIdx: index('tenant_memberships_tenant_idx').on(t.tenantId),

  // Lookup: "all tenants this user belongs to" (e.g., tenant switcher)
  userIdx: index('tenant_memberships_user_idx').on(t.platformUserId),
}));

/**
 * tenant_invitations — pending invites to join a tenant
 *
 * Better-Auth organization plugin maps this as "invitation" model.
 */
export const tenantInvitations = pgTable('tenant_invitations', {
  id: uuid('id').primaryKey().defaultRandom(),

  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' }),

  // The email being invited (may not have a platform_user record yet)
  email: text('email').notNull(),

  // Role they'll have once accepted
  role: tenantRoleEnum('role').notNull(),

  // pending | accepted | declined | expired
  status: text('status').notNull().default('pending'),

  // Who sent the invite
  inviterId: uuid('inviter_id')
    .notNull()
    .references(() => platformUsers.id, { onDelete: 'cascade' }),

  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  // One pending invite per (tenant, email) — prevent duplicate invites
  uniquePending: uniqueIndex('tenant_invitations_pending_idx')
    .on(t.tenantId, t.email)
    .where(sql`${t.status} = 'pending'`),
}));

// ============================================================================
// STOREFRONT IDENTITY (apps/storefront)
// ============================================================================
//
// Tenant-scoped end users. Same person at different tenants = different records.
// Same person across all brands of same tenant = ONE record.

/**
 * tenant_end_users — guest accounts
 *
 * Better-Auth maps this as "user" model in storefront instance.
 * Identity is scoped to tenant: UNIQUE(tenant_id, email).
 */
export const tenantEndUsers = pgTable('tenant_end_users', {
  id: uuid('id').primaryKey().defaultRandom(),

  // KEY DECISION: scope to tenant, not brand.
  // One account works across all brands of this tenant.
  // Cross-brand recognition handled at app layer with disclosure UX.
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' }),

  email: text('email').notNull(),
  // Required by Better-Auth core; signup paths supply a fallback.
  name: text('name').notNull(),
  // Better-Auth core shape: boolean, default false, input:false.
  // v2 audit-timestamp path lives in a separate column + databaseHooks.
  emailVerified: boolean('email_verified').notNull().default(false),
  imageUrl: text('image_url'),

  // Phone optional in v1 (no SMS OTP, but might want for delivery contact)
  phone: text('phone'),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
}, (t) => ({
  // CRITICAL CONSTRAINT: email unique per tenant, not globally.
  // John can exist at Tenant A AND Tenant B independently.
  // Partial: allows re-signup after soft delete.
  emailPerTenantIdx: uniqueIndex('tenant_end_users_tenant_email_idx')
    .on(t.tenantId, t.email)
    .where(sql`${t.deletedAt} IS NULL`),

  // Lookup: list all end users of a tenant (for analytics, CRM)
  tenantIdx: index('tenant_end_users_tenant_idx').on(t.tenantId),
}));

/**
 * tenant_end_user_accounts — credentials for end users
 *
 * Hybrid auth: end user can have password AND/OR Google OAuth.
 * Plus OTP works without any account record (just needs email).
 */
export const tenantEndUserAccounts = pgTable('tenant_end_user_accounts', {
  id: uuid('id').primaryKey().defaultRandom(),

  // DEL-12: tenant scoping for OAuth uniqueness. (provider_id, account_id) was
  // globally unique pre-DEL-12 — a Google account could only link to one
  // tenant_end_user globally. Now uniqueness is per-tenant, so the same Google
  // account at Tenant A vs Tenant B creates two independent account rows.
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' }),

  tenantEndUserId: uuid('tenant_end_user_id')
    .notNull()
    .references(() => tenantEndUsers.id, { onDelete: 'cascade' }),

  providerId: text('provider_id').notNull(),  // "credential" | "google"
  accountId: text('account_id').notNull(),

  // For password auth (HYBRID variant — end users CAN have password)
  password: text('password'),

  // OAuth tokens
  accessToken: text('access_token'),
  refreshToken: text('refresh_token'),
  idToken: text('id_token'),
  accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }),
  refreshTokenExpiresAt: timestamp('refresh_token_expires_at', { withTimezone: true }),
  scope: text('scope'),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  // DEL-12: replaces the global unique(provider_id, account_id) with a
  // tenant-scoped one. See docs/specs/del-12-account-tenant-scoping.md.
  tenantProviderAccountIdx: uniqueIndex('tenant_end_user_accounts_tenant_provider_account_idx')
    .on(t.tenantId, t.providerId, t.accountId),

  userIdx: index('tenant_end_user_accounts_user_idx').on(t.tenantEndUserId),
}));

/**
 * tenant_end_user_sessions — login sessions for end users
 *
 * Includes current_brand_id: tracks which brand context the session is in.
 * Same tenant_end_user can have separate sessions per brand (e.g., logged
 * in to both pizza-express tab and burger-heaven tab).
 */
export const tenantEndUserSessions = pgTable('tenant_end_user_sessions', {
  id: uuid('id').primaryKey().defaultRandom(),

  // Tenant scoping — closes the cross-tenant cookie-replay defense-in-depth
  // gap surfaced during DEL-26. BA's getSession does a relational lookup
  // that joins user data inline; without a `tenant_id` on the session row,
  // the wrapped adapter's user-side tenant predicate never gets a chance
  // to filter the join. See docs/specs/session-model-scoped.md +
  // ADR-0010 § Amendments.
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' }),

  tenantEndUserId: uuid('tenant_end_user_id')
    .notNull()
    .references(() => tenantEndUsers.id, { onDelete: 'cascade' }),

  // The brand this session was authenticated through, when applicable.
  // NULL for food-hall (tenant-mode) sessions per ADR-0012 §"Session model
  // (target)" / DEL-21. Used for theming, brand-specific UI, and audit
  // ("user shopped at Pizza Express") when a brand context exists.
  currentBrandId: uuid('current_brand_id').references(() => brands.id, { onDelete: 'cascade' }),

  token: text('token').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),

  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  tokenIdx: uniqueIndex('tenant_end_user_sessions_token_idx').on(t.token),
  tenantIdx: index('tenant_end_user_sessions_tenant_idx').on(t.tenantId),
  userIdx: index('tenant_end_user_sessions_user_idx').on(t.tenantEndUserId),
  brandIdx: index('tenant_end_user_sessions_brand_idx').on(t.currentBrandId),
  expiresIdx: index('tenant_end_user_sessions_expires_idx').on(t.expiresAt),
}));

/**
 * tenant_end_user_verifications — OTP + email verify + password reset
 *
 * Includes tenant_id and brand_id for branding the email template
 * and rate-limiting per tenant.
 */
export const tenantEndUserVerifications = pgTable('tenant_end_user_verifications', {
  id: uuid('id').primaryKey().defaultRandom(),

  // The email being verified / OTP-authenticated
  identifier: text('identifier').notNull(),

  // Stored hashed
  value: text('value').notNull(),

  // Tenant context (for rate limiting and email scoping)
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' }),

  // Brand context (for email theming and analytics)
  // Optional: email_verify and password_reset can happen brand-agnostically
  brandId: uuid('brand_id')
    .references(() => brands.id, { onDelete: 'set null' }),

  // Type of verification — useful for analytics and security audit
  type: verificationTypeEnum('type').notNull(),

  // Failed attempts counter. NOTE (DEL-9): kept for legacy/observability,
  // but Better-Auth 1.6.11 actually encodes attempts inside `value` as
  // `${otp_hash}:${N}` (see node_modules/.../email-otp/routes.mjs:243-251).
  // The rate limiter parses attempts from `value`, not from this column.
  attempts: integer('attempts').notNull().default(0),

  // DEL-9: timestamp of the most recent request to send this OTP, used by
  // checkOtpRequest to enforce the 60s-per-request rate limit. Equal to
  // created_at in v1 (BA creates a new row per send), but kept as a
  // dedicated column to stay accurate if BA ever switches to row reuse.
  lastRequestedAt: timestamp('last_requested_at', { withTimezone: true })
    .notNull()
    .defaultNow(),

  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  // Lookup by (tenant, identifier) — most common path during OTP verify
  tenantIdentifierIdx: index('tenant_end_user_verifications_tenant_id_idx')
    .on(t.tenantId, t.identifier),

  expiresIdx: index('tenant_end_user_verifications_expires_idx').on(t.expiresAt),

  // DEL-9: covers the rate-limit lookup
  //   SELECT ... WHERE tenant_id=? AND identifier=? AND type='otp_login'
  //   ORDER BY last_requested_at DESC LIMIT 1
  rateLimitIdx: index('tenant_end_user_verifications_rate_limit_idx')
    .on(t.tenantId, t.identifier, t.type, t.lastRequestedAt.desc()),
}));

/**
 * tenant_otp_lockouts — survives BA's verification-row delete on max attempts
 *
 * Better-Auth's `allowedAttempts` config deletes the verification row when
 * the limit is hit (email-otp/routes.mjs:245-247), wiping any per-row
 * cooldown state. This separate table holds the lockout marker so the
 * 15-minute cooldown (auth-spec §6 AC#8) can be enforced on subsequent
 * OTP requests. Scope is per (tenant_id, identifier) — matches the
 * tenant-scoped identity invariant from ADR-0003.
 *
 * DEL-9 / docs/specs/otp-rate-limiting.md.
 */
export const tenantOtpLockouts = pgTable('tenant_otp_lockouts', {
  id: uuid('id').primaryKey().defaultRandom(),

  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' }),

  // Lowercased email (matches verification.identifier shape).
  identifier: text('identifier').notNull(),

  // Why the lockout was created. Used by checkOtpRequest to map back to
  // the right error code:
  //   - 'too_frequent' → 60s post-send throttle (auth-spec §6 AC#8 first half)
  //   - 'cooldown'     → 15min after 5 failed verifies (second half)
  // The 'too_frequent' rows live in this table (and not on the verification
  // row's last_requested_at) because BA's resolveOTP catches verification.create
  // errors and re-creates after delete — wiping any verification-row-bound
  // state. The lockout table survives BA's delete cycle.
  reason: text('reason').notNull().default('cooldown'),

  // When the cooldown lifts. checkOtpRequest filters `expires_at > now()`.
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  // Hot path: "is there an unexpired lockout for this (tenant, email)?"
  lookupIdx: index('tenant_otp_lockouts_lookup_idx')
    .on(t.tenantId, t.identifier, t.expiresAt.desc()),
}));

// ============================================================================
// COMMERCE (DEL-24 / ADR-0012 §"Commerce model")
// ============================================================================
//
// Carts and orders are scoped to (tenant, location, customer) — NO brand_id
// ownership column on the parent rows. Brand context lives on line items so
// a single cart / single order can span brands in food-hall mode (mode 3
// per ADR-0012).
//
// Menus and menu_items belong to brand. Tenant-safety is transitive via
// brand.tenant_id (no direct tenant_id on menus / menu_items per AC#5).
//
// FK action policy:
//   - Tenant-boundary chains (tenant_id, location_id) CASCADE for GDPR
//     full-tenant cleanup.
//   - orders.tenant_end_user_id is SET NULL — preserves order history
//     through single-user GDPR anonymization.
//   - order_line_items.brand_id is SET NULL + brand_name_snapshot —
//     preserves audit history through single-brand removal (intentional
//     deviation from AC#4; cart_items.brand_id stays NOT NULL since cart
//     items are transient).
//
// Spec: docs/specs/commerce-schema-v1.md.

/**
 * menus — brand-owned menus
 *
 * One brand can have N menus (e.g., breakfast vs lunch). Tenant-safety is
 * transitive via brand.tenant_id — no direct tenant_id column (AC#5).
 */
export const menus = pgTable('menus', {
  id: uuid('id').primaryKey().defaultRandom(),

  brandId: uuid('brand_id')
    .notNull()
    .references(() => brands.id, { onDelete: 'cascade' }),

  name: text('name').notNull(),
  description: text('description'),

  isActive: boolean('is_active').notNull().default(true),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
}, (t) => ({
  brandIdx: index('menus_brand_idx').on(t.brandId),
}));

/**
 * menu_items — items inside a menu
 *
 * Brand reached transitively via menu (menu_item → menu → brand). NO
 * direct brand_id column — keeps a single source of truth and avoids
 * drift between menu_items.brand_id and menu.brand_id.
 */
export const menuItems = pgTable('menu_items', {
  id: uuid('id').primaryKey().defaultRandom(),

  menuId: uuid('menu_id')
    .notNull()
    .references(() => menus.id, { onDelete: 'cascade' }),

  name: text('name').notNull(),
  description: text('description'),

  // Stored in integer cents — avoids floating-point bugs around money.
  priceCents: integer('price_cents').notNull(),

  isActive: boolean('is_active').notNull().default(true),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),

  // DEL-34 / X3 (additive). slug: nullable, no uniqueness yet (add a partial
  // unique + backfill when routing/SEO consumes it). category_id: nullable FK,
  // ON DELETE SET NULL so deleting a category doesn't delete items. No image_id
  // yet (deferred with media_assets until an upload flow exists).
  slug: text('slug'),
  categoryId: uuid('category_id').references(() => categories.id, { onDelete: 'set null' }),
}, (t) => ({
  menuIdx: index('menu_items_menu_idx').on(t.menuId),
  categoryIdx: index('menu_items_category_idx').on(t.categoryId),
}));

// ============================================================================
// CATALOG SPINE (DEL-34 / X3)
// ============================================================================
//
// Brand-owned categories + modifiers. Tenant-safety is transitive via
// brand.tenant_id (no direct tenant_id, same as menus/menu_items). The
// ModifierSnapshot soft pointers (cart_items / order_intent_items) reference
// modifier_groups.id + modifiers.id by id (no FK) — see ./modifier-snapshot.ts.
// Same-brand integrity (an item's category/groups belong to its brand) is an
// app-layer concern, NOT DB-enforced.

/**
 * categories — brand-owned menu sections (e.g. "Mains", "Sides").
 */
export const categories = pgTable('categories', {
  id: uuid('id').primaryKey().defaultRandom(),

  brandId: uuid('brand_id')
    .notNull()
    .references(() => brands.id, { onDelete: 'cascade' }),

  name: text('name').notNull(),
  sortOrder: integer('sort_order').notNull().default(0),
  isActive: boolean('is_active').notNull().default(true),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
}, (t) => ({
  brandIdx: index('categories_brand_idx').on(t.brandId),
}));

/**
 * modifier_groups — brand-owned groups of modifier options attached to menu
 * items (e.g. "Size", "Toppings"). selection_type + min/max_select bound the
 * choice; max_select NULL = unlimited.
 */
export const modifierGroups = pgTable('modifier_groups', {
  id: uuid('id').primaryKey().defaultRandom(),

  brandId: uuid('brand_id')
    .notNull()
    .references(() => brands.id, { onDelete: 'cascade' }),

  name: text('name').notNull(),
  selectionType: modifierSelectionTypeEnum('selection_type').notNull(),
  minSelect: integer('min_select').notNull().default(0),
  maxSelect: integer('max_select'),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
}, (t) => ({
  brandIdx: index('modifier_groups_brand_idx').on(t.brandId),
}));

/**
 * modifiers — selectable options within a modifier_group. price_delta_cents
 * may be negative (a discount); is_default pre-selects the option.
 */
export const modifiers = pgTable('modifiers', {
  id: uuid('id').primaryKey().defaultRandom(),

  modifierGroupId: uuid('modifier_group_id')
    .notNull()
    .references(() => modifierGroups.id, { onDelete: 'cascade' }),

  name: text('name').notNull(),
  priceDeltaCents: integer('price_delta_cents').notNull().default(0),
  isDefault: boolean('is_default').notNull().default(false),
  sortOrder: integer('sort_order').notNull().default(0),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
}, (t) => ({
  groupIdx: index('modifiers_group_idx').on(t.modifierGroupId),
}));

/**
 * menu_item_modifier_groups — M:N join attaching modifier_groups to menu_items.
 * Composite PK = no duplicate links; sort_order orders the groups on an item.
 */
export const menuItemModifierGroups = pgTable('menu_item_modifier_groups', {
  menuItemId: uuid('menu_item_id')
    .notNull()
    .references(() => menuItems.id, { onDelete: 'cascade' }),

  modifierGroupId: uuid('modifier_group_id')
    .notNull()
    .references(() => modifierGroups.id, { onDelete: 'cascade' }),

  sortOrder: integer('sort_order').notNull().default(0),
}, (t) => ({
  pk: primaryKey({ columns: [t.menuItemId, t.modifierGroupId] }),
  // Reverse lookup: "which items use this modifier group?"
  modifierGroupIdx: index('menu_item_modifier_groups_modifier_group_idx').on(t.modifierGroupId),
}));

/**
 * carts — open shopping carts
 *
 * Scoped to (tenant, location, end_user). NO brand_id (AC#3) — line items
 * carry brand. Anonymous carts deferred to v2; tenant_end_user_id is
 * NOT NULL in v1. App enforces "most recent active cart per (user,
 * location)" — no DB-level uniqueness in v1.
 */
export const carts = pgTable('carts', {
  id: uuid('id').primaryKey().defaultRandom(),

  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' }),

  locationId: uuid('location_id')
    .notNull()
    .references(() => locations.id, { onDelete: 'cascade' }),

  tenantEndUserId: uuid('tenant_end_user_id')
    .notNull()
    .references(() => tenantEndUsers.id, { onDelete: 'cascade' }),

  status: cartStatusEnum('status').notNull().default('active'),

  // Decided at cart creation (UX picks pickup/delivery before adding
  // items). Carried forward to the order at checkout. Orthogonal to
  // order_status — see enum comment above.
  fulfillmentType: fulfillmentTypeEnum('fulfillment_type').notNull().default('pickup'),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
}, (t) => ({
  tenantIdx: index('carts_tenant_idx').on(t.tenantId),
  userIdx: index('carts_user_idx').on(t.tenantEndUserId),
  locationIdx: index('carts_location_idx').on(t.locationId),
  statusIdx: index('carts_status_idx').on(t.status),
}));

/**
 * cart_items — line items inside a cart
 *
 * brand_id is NOT NULL CASCADE per AC#4. Cart items are transient —
 * losing them when a tenant/brand/menu_item is hard-deleted is acceptable.
 *
 * unit_price_cents is a snapshot at add-to-cart time so concurrent
 * menu_item price edits don't mutate the cart line under the customer.
 */
export const cartItems = pgTable('cart_items', {
  id: uuid('id').primaryKey().defaultRandom(),

  cartId: uuid('cart_id')
    .notNull()
    .references(() => carts.id, { onDelete: 'cascade' }),

  brandId: uuid('brand_id')
    .notNull()
    .references(() => brands.id, { onDelete: 'cascade' }),

  menuItemId: uuid('menu_item_id')
    .notNull()
    .references(() => menuItems.id, { onDelete: 'cascade' }),

  quantity: integer('quantity').notNull().default(1),

  // Typed per-line modifier snapshots (DEL-30). See ./modifier-snapshot.ts.
  modifiersJson: jsonb('modifiers_json').$type<ModifierSnapshot[]>().notNull().default([]),

  // Snapshot at add-to-cart. See doc-comment above.
  unitPriceCents: integer('unit_price_cents').notNull(),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  cartIdx: index('cart_items_cart_idx').on(t.cartId),
  brandIdx: index('cart_items_brand_idx').on(t.brandId),
  menuItemIdx: index('cart_items_menu_item_idx').on(t.menuItemId),
}));

/**
 * order_intents — the order aggregate root (DEL-32 / X1).
 *
 * What the customer committed to ("placed"). Intent-only status — the
 * kitchen lifecycle lives on order_fulfillments. Append-only historical
 * record (no deletedAt; cancel via status='cancelled'). Mirrors the old
 * `orders` tenant/GDPR design: tenant_id direct (CASCADE); tenant_end_user_id
 * nullable + SET NULL so single-user GDPR delete preserves the record.
 *
 * created_at IS the placement time in v1 (intent is born 'placed'; no draft
 * state). idempotency_key is the agent/API dedup (L3) — storefront writes
 * NULL and relies on the cart-conversion guard. placed_by_actor_* stamps the
 * actor (DEL-33 / X2).
 */
export const orderIntents = pgTable('order_intents', {
  id: uuid('id').primaryKey().defaultRandom(),

  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' }),

  locationId: uuid('location_id')
    .notNull()
    .references(() => locations.id, { onDelete: 'cascade' }),

  // NULLABLE + SET NULL — preserves intent history through single-user GDPR
  // delete (same policy as the old orders table).
  tenantEndUserId: uuid('tenant_end_user_id')
    .references(() => tenantEndUsers.id, { onDelete: 'set null' }),

  // Origin of the intent. text (not enum) — channels proliferate.
  channel: text('channel').notNull().default('storefront'),

  // Actor stamp (DEL-33 / X2). actor_id is an application-level pointer —
  // no FK (may reference platform_users OR tenant_end_users OR nothing).
  placedByActorType: actorTypeEnum('placed_by_actor_type').notNull(),
  placedByActorId: uuid('placed_by_actor_id'),

  // Agent/API order-creation dedup (L3). Storefront writes NULL (the cart
  // guard is the storefront dedup); the partial-unique index ignores NULLs.
  idempotencyKey: text('idempotency_key'),

  subtotalCents: integer('subtotal_cents').notNull(),
  taxCents: integer('tax_cents').notNull().default(0),
  feeCents: integer('fee_cents').notNull().default(0),
  tipCents: integer('tip_cents').notNull().default(0),
  totalCents: integer('total_cents').notNull(),

  status: orderIntentStatusEnum('status').notNull().default('placed'),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  // Tenant-scoped recency (admin "recent orders", per-tenant cron walks).
  tenantCreatedAtIdx: index('order_intents_tenant_created_at_idx').on(t.tenantId, t.createdAt.desc()),
  userIdx: index('order_intents_user_idx').on(t.tenantEndUserId),
  locationIdx: index('order_intents_location_idx').on(t.locationId),
  // Agent/API idempotency — UNIQUE per tenant, ignoring storefront NULLs.
  idempotencyUnique: uniqueIndex('order_intents_idempotency_unique')
    .on(t.tenantId, t.idempotencyKey)
    .where(sql`${t.idempotencyKey} IS NOT NULL`),
}));

/**
 * order_intent_items — immutable snapshot lines inside an order intent
 * (DEL-32 / X1). Mirrors the old order_line_items exactly: brand_id nullable
 * + SET NULL with brand_name_snapshot carrying identity forward; soft
 * menu_item_id_snapshot; typed modifier snapshots. No timestamps, no soft
 * delete — created with the intent, never edited.
 */
export const orderIntentItems = pgTable('order_intent_items', {
  id: uuid('id').primaryKey().defaultRandom(),

  orderIntentId: uuid('order_intent_id')
    .notNull()
    .references(() => orderIntents.id, { onDelete: 'cascade' }),

  // NULLABLE + SET NULL — preserves audit history through single-brand
  // hard-delete; brand_name_snapshot carries the identity forward.
  brandId: uuid('brand_id')
    .references(() => brands.id, { onDelete: 'set null' }),
  brandNameSnapshot: text('brand_name_snapshot').notNull(),

  // Soft pointer (no .references()) — survives menu_item hard-delete.
  menuItemIdSnapshot: uuid('menu_item_id_snapshot'),
  nameSnapshot: text('name_snapshot').notNull(),

  quantity: integer('quantity').notNull(),

  // Typed per-line modifier snapshots (DEL-30). See ./modifier-snapshot.ts.
  modifiersSnapshotJson: jsonb('modifiers_snapshot_json').$type<ModifierSnapshot[]>().notNull().default([]),

  unitPriceCents: integer('unit_price_cents').notNull(),
  totalCents: integer('total_cents').notNull(),
}, (t) => ({
  intentIdx: index('order_intent_items_intent_idx').on(t.orderIntentId),
  brandIdx: index('order_intent_items_brand_idx').on(t.brandId),
}));

/**
 * order_fulfillments — one per (intent, brand); the KDS ticket and query
 * root (DEL-32 / X1). Carries a DENORMALIZED tenant_id so KDS (X6) can query
 * (tenant_id, location_id, status) without joining through order_intents —
 * same denormalization as orders/carts. brand_id nullable + SET NULL with
 * brand_name_snapshot. status is the kitchen lifecycle (fulfillment_status);
 * transitions are validated by ./fulfillment-status.ts and driven by X6.
 */
export const orderFulfillments = pgTable('order_fulfillments', {
  id: uuid('id').primaryKey().defaultRandom(),

  orderIntentId: uuid('order_intent_id')
    .notNull()
    .references(() => orderIntents.id, { onDelete: 'cascade' }),

  // Denormalized for the KDS query root (X6); CASCADE for tenant GDPR cleanup.
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' }),

  // NULLABLE + SET NULL — brand_name_snapshot carries identity forward.
  brandId: uuid('brand_id')
    .references(() => brands.id, { onDelete: 'set null' }),
  brandNameSnapshot: text('brand_name_snapshot').notNull(),

  locationId: uuid('location_id')
    .notNull()
    .references(() => locations.id, { onDelete: 'cascade' }),

  fulfillmentType: fulfillmentTypeEnum('fulfillment_type').notNull(),
  status: fulfillmentStatusEnum('status').notNull().default('queued'),

  estimatedReadyAt: timestamp('estimated_ready_at', { withTimezone: true }),
  completedAt: timestamp('completed_at', { withTimezone: true }),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  intentIdx: index('order_fulfillments_intent_idx').on(t.orderIntentId),
  // The KDS list query: open tickets for a tenant's location, by status.
  tenantLocationStatusIdx: index('order_fulfillments_tenant_location_status_idx')
    .on(t.tenantId, t.locationId, t.status),
}));

/**
 * order_fulfillment_items — maps intent items into a fulfillment ticket
 * (DEL-32 / X1). Exists to allow future splits/merges; v1 maps each intent
 * item fully into its brand's single fulfillment.
 */
export const orderFulfillmentItems = pgTable('order_fulfillment_items', {
  id: uuid('id').primaryKey().defaultRandom(),

  orderFulfillmentId: uuid('order_fulfillment_id')
    .notNull()
    .references(() => orderFulfillments.id, { onDelete: 'cascade' }),

  orderIntentItemId: uuid('order_intent_item_id')
    .notNull()
    .references(() => orderIntentItems.id, { onDelete: 'cascade' }),

  quantity: integer('quantity').notNull(),
}, (t) => ({
  fulfillmentIdx: index('order_fulfillment_items_fulfillment_idx').on(t.orderFulfillmentId),
  intentItemIdx: index('order_fulfillment_items_intent_item_idx').on(t.orderIntentItemId),
}));

/**
 * order_modifications — append-only log of post-placement changes to an
 * intent (DEL-32 / X1): comps, partial cancels, price adjustments, refunds
 * (X4 links here). The table lands now so X4/refunds can reference it; the
 * mutation FLOWS are out of scope for X1 (created empty, no backfill).
 */
export const orderModifications = pgTable('order_modifications', {
  id: uuid('id').primaryKey().defaultRandom(),

  orderIntentId: uuid('order_intent_id')
    .notNull()
    .references(() => orderIntents.id, { onDelete: 'cascade' }),

  // Free-form discriminator for v1 (e.g. 'comp', 'partial_cancel',
  // 'price_adjust', 'refund'); typed when the modification flows land.
  kind: text('kind').notNull(),

  // Actor stamp (DEL-33 / X2).
  actorType: actorTypeEnum('actor_type').notNull(),
  actorId: uuid('actor_id'),

  payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
  financialDeltaCents: integer('financial_delta_cents').notNull().default(0),

  appliedAt: timestamp('applied_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  intentIdx: index('order_modifications_intent_idx').on(t.orderIntentId),
}));

// ============================================================================
// PAYMENTS (DEL-35 / X4)
// ============================================================================
//
// Money movement via a payment provider (Stripe: Express accounts + destination
// charges). Stamped idempotently by the Stripe webhook — UNIQUE (provider,
// external_id) + ON CONFLICT DO NOTHING absorbs webhook redelivery, and the
// payment.captured / payment.refunded outbox events are emitted ONLY on a
// genuinely new row. tenant_id is the direct scoping column (RLS-ready) and
// keeps tenant GDPR cascade working.

/**
 * payments — a captured charge for an order intent. external_id is the Stripe
 * PaymentIntent id (pi_…); amount_cents is amount_received (the captured
 * amount). application_fee_cents is the platform's Connect cut — nullable
 * because reading it reliably may need a latest_charge expansion.
 */
export const payments = pgTable('payments', {
  id: uuid('id').primaryKey().defaultRandom(),

  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' }),

  orderIntentId: uuid('order_intent_id')
    .notNull()
    .references(() => orderIntents.id, { onDelete: 'cascade' }),

  // Provider-agnostic; 'stripe' is the only value at launch.
  provider: text('provider').notNull().default('stripe'),
  // Stripe PaymentIntent id (pi_…) — the stable per-payment dedup handle.
  externalId: text('external_id').notNull(),

  amountCents: integer('amount_cents').notNull(),
  currency: text('currency').notNull().default('usd'),
  // Platform cut (Connect application_fee_amount). Nullable — see above.
  applicationFeeCents: integer('application_fee_cents'),

  status: paymentStatusEnum('status').notNull(),

  capturedAt: timestamp('captured_at', { withTimezone: true }),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  // Row-level webhook idempotency — one payment row per provider object.
  providerExternalUnique: uniqueIndex('payments_provider_external_id_unique')
    .on(t.provider, t.externalId),
  tenantCreatedAtIdx: index('payments_tenant_created_at_idx').on(t.tenantId, t.createdAt.desc()),
  orderIntentIdx: index('payments_order_intent_idx').on(t.orderIntentId),
}));

/**
 * refunds — money returned against a payment (one payment has N refunds for
 * partial refunds). Stamped by the charge.refunded webhook with the same
 * idempotency shape as payments. Full-unwind economics: reverse_transfer claws
 * back the restaurant's transferred share (transfer_reversed) and
 * refund_application_fee returns the platform cut (application_fee_refunded_cents)
 * — both recorded here for reconciliation. Each new refund also writes an
 * order_modifications(kind='refund') ledger row, linked via order_modification_id.
 */
export const refunds = pgTable('refunds', {
  id: uuid('id').primaryKey().defaultRandom(),

  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' }),

  paymentId: uuid('payment_id')
    .notNull()
    .references(() => payments.id, { onDelete: 'cascade' }),

  // Optional link to the append-only ledger entry. SET NULL — the refund
  // record (money moved) outlives a modification-row cleanup.
  orderModificationId: uuid('order_modification_id')
    .references(() => orderModifications.id, { onDelete: 'set null' }),

  provider: text('provider').notNull().default('stripe'),
  // Stripe Refund id (re_…).
  externalId: text('external_id').notNull(),

  amountCents: integer('amount_cents').notNull(),
  status: refundStatusEnum('status').notNull(),

  // Full-unwind reconciliation: did we reverse the destination transfer, and
  // how much application fee did we return.
  transferReversed: boolean('transfer_reversed').notNull().default(false),
  applicationFeeRefundedCents: integer('application_fee_refunded_cents'),

  processedAt: timestamp('processed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  providerExternalUnique: uniqueIndex('refunds_provider_external_id_unique')
    .on(t.provider, t.externalId),
  paymentIdx: index('refunds_payment_idx').on(t.paymentId),
  tenantCreatedAtIdx: index('refunds_tenant_created_at_idx').on(t.tenantId, t.createdAt.desc()),
}));

// ============================================================================
// EVENT OUTBOX (DEL-29 / N2)
// ============================================================================
//
// Transactional outbox for domain events. Writers append rows in the SAME
// db.transaction as their mutation (cart/checkout) or via BA's
// queueAfterTransactionHook (guest signup/signin — post-commit). The
// outbox-dispatcher Inngest cron (in @rp/events) polls, publishes via
// step.sendEvent with a stable id for dedup, then batch-marks published_at.
//
// occurred_at = domain time (set by writer). created_at = wall-clock row
// insert (defaultNow). For freshly-emitted events they're within ms;
// backfilled/replayed events can diverge by hours/days.
//
// idempotency_key is per-event (userId / sessionId / orderId / null for
// cart.item_added) and the partial unique index below enforces dedup for
// BA retries. INSERT ... ON CONFLICT DO NOTHING in @rp/events writer.
//
// RLS-ready: tenant_id is the direct scoping column.

export const eventOutbox = pgTable('event_outbox', {
  id: uuid('id').primaryKey().defaultRandom(),

  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' }),

  // Bounded domain partition. Examples: 'guest', 'cart', 'order'.
  aggregateType: text('aggregate_type').notNull(),
  // Domain-meaningful UUID — points into the producing table. No FK because
  // the consumer side doesn't care about referential integrity at this layer
  // and FKs would prevent hard-delete cleanup workflows.
  aggregateId: uuid('aggregate_id').notNull(),

  // Dot-notation. Examples: 'guest.signed_up', 'order_intent.placed'.
  // Renamed via dual-emit window on payload-breaking changes (see
  // packages/events/README.md deprecation lifecycle).
  eventType: text('event_type').notNull(),
  // Bumped only for breaking payload changes. Additive optional fields
  // stay on the same version. Consumers tolerate unknown fields.
  eventVersion: integer('event_version').notNull().default(1),

  // Full event payload. Shape validated by Zod schemas in @rp/events.
  payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),

  // NOT NULL — every event has an actor (defaults to 'system' if nothing
  // else). Future agent/service-account events use other values.
  actorType: text('actor_type').notNull(),
  // Nullable for system-emitted events.
  actorId: uuid('actor_id'),

  // Used to dedup writer retries (BA flow replays, etc.).
  // Enforced by the partial unique index below.
  idempotencyKey: text('idempotency_key'),
  // Tracing: id of the request that caused this event.
  causationId: uuid('causation_id'),
  // Tracing: id of the conceptual unit-of-work spanning multiple events.
  correlationId: uuid('correlation_id'),

  // Domain time of the event (set by writer).
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
  // Wall-clock row creation (set by Postgres default).
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  // NULL until outbox-dispatcher publishes.
  publishedAt: timestamp('published_at', { withTimezone: true }),
}, (t) => ({
  // Dispatcher claim hot-path: scan unpublished rows by occurred_at.
  pendingIdx: index('event_outbox_pending_idx')
    .on(t.occurredAt)
    .where(sql`${t.publishedAt} IS NULL`),

  // Consumer hot-path: "all events for aggregate X, in order."
  aggregateIdx: index('event_outbox_aggregate_idx')
    .on(t.tenantId, t.aggregateType, t.aggregateId, t.occurredAt),

  // Consumer hot-path: "all guest.signed_up events for tenant Y."
  eventTypeIdx: index('event_outbox_event_type_idx')
    .on(t.tenantId, t.eventType, t.occurredAt),

  // Idempotency: enforce uniqueness ONLY when idempotency_key is non-null.
  // Without this, the field is decorative — a BA retry would double-publish.
  // Pair with INSERT ... ON CONFLICT DO NOTHING in @rp/events writer.
  idempotencyUnique: uniqueIndex('event_outbox_idempotency_unique')
    .on(t.tenantId, t.eventType, t.idempotencyKey)
    .where(sql`${t.idempotencyKey} IS NOT NULL`),
}));

// ============================================================================
// TYPE HELPERS (for application code)
// ============================================================================

export type BrandBranding = {
  primary?: string;        // hex color
  secondary?: string;
  logo?: string;           // URL
  font?: string;
  ogImage?: string;
};

// Drizzle type inference — these power TypeScript types in your app
export type PlatformUser = typeof platformUsers.$inferSelect;
export type NewPlatformUser = typeof platformUsers.$inferInsert;

export type Tenant = typeof tenants.$inferSelect;
export type Brand = typeof brands.$inferSelect;
export type Location = typeof locations.$inferSelect;

export type TenantEndUser = typeof tenantEndUsers.$inferSelect;
export type NewTenantEndUser = typeof tenantEndUsers.$inferInsert;

export type TenantMembership = typeof tenantMemberships.$inferSelect;

export type TenantOtpLockout = typeof tenantOtpLockouts.$inferSelect;
export type NewTenantOtpLockout = typeof tenantOtpLockouts.$inferInsert;

export type Storefront = typeof storefronts.$inferSelect;
export type NewStorefront = typeof storefronts.$inferInsert;

// DEL-24: commerce types
export type Menu = typeof menus.$inferSelect;
export type NewMenu = typeof menus.$inferInsert;

export type MenuItem = typeof menuItems.$inferSelect;
export type NewMenuItem = typeof menuItems.$inferInsert;

// DEL-34 / X3: catalog types
export type Category = typeof categories.$inferSelect;
export type NewCategory = typeof categories.$inferInsert;

export type ModifierGroup = typeof modifierGroups.$inferSelect;
export type NewModifierGroup = typeof modifierGroups.$inferInsert;

export type Modifier = typeof modifiers.$inferSelect;
export type NewModifier = typeof modifiers.$inferInsert;

export type MenuItemModifierGroup = typeof menuItemModifierGroups.$inferSelect;
export type NewMenuItemModifierGroup = typeof menuItemModifierGroups.$inferInsert;

export type Cart = typeof carts.$inferSelect;
export type NewCart = typeof carts.$inferInsert;

export type CartItem = typeof cartItems.$inferSelect;
export type NewCartItem = typeof cartItems.$inferInsert;

export type OrderIntent = typeof orderIntents.$inferSelect;
export type NewOrderIntent = typeof orderIntents.$inferInsert;

export type OrderIntentItem = typeof orderIntentItems.$inferSelect;
export type NewOrderIntentItem = typeof orderIntentItems.$inferInsert;

export type OrderFulfillment = typeof orderFulfillments.$inferSelect;
export type NewOrderFulfillment = typeof orderFulfillments.$inferInsert;

export type OrderFulfillmentItem = typeof orderFulfillmentItems.$inferSelect;
export type NewOrderFulfillmentItem = typeof orderFulfillmentItems.$inferInsert;

export type OrderModification = typeof orderModifications.$inferSelect;
export type NewOrderModification = typeof orderModifications.$inferInsert;

// DEL-35: payments + refunds
export type Payment = typeof payments.$inferSelect;
export type NewPayment = typeof payments.$inferInsert;

export type Refund = typeof refunds.$inferSelect;
export type NewRefund = typeof refunds.$inferInsert;

// DEL-29: event outbox
export type EventOutbox = typeof eventOutbox.$inferSelect;
export type NewEventOutbox = typeof eventOutbox.$inferInsert;

// ============================================================================
// RELATIONS (for Drizzle's relational queries)
// ============================================================================

export const platformUsersRelations = relations(platformUsers, ({ many }) => ({
  accounts: many(platformAccounts),
  sessions: many(platformSessions),
  memberships: many(tenantMemberships),
}));

export const tenantsRelations = relations(tenants, ({ many }) => ({
  locations: many(locations),
  brands: many(brands),
  memberships: many(tenantMemberships),
  endUsers: many(tenantEndUsers),
  storefronts: many(storefronts),
  // DEL-24: commerce.
  carts: many(carts),
  orderIntents: many(orderIntents),
  orderFulfillments: many(orderFulfillments),
  // DEL-35: payments.
  payments: many(payments),
  refunds: many(refunds),
}));

export const brandsRelations = relations(brands, ({ one, many }) => ({
  tenant: one(tenants, {
    fields: [brands.tenantId],
    references: [tenants.id],
  }),
  locations: many(locationBrands),
  // DEL-19: a brand can have many storefront rows over its lifetime
  // (e.g., after slug rename + soft-delete cycle). No reverse "primary
  // storefront" pointer — app-layer picks the active one when needed.
  storefronts: many(storefronts),
  // DEL-24: commerce. Note: no direct menuItems relation — chain is
  // brand → menus → menu_items per ADR-0012 / spec § "Data Model Changes".
  menus: many(menus),
  // DEL-34 / X3: catalog.
  categories: many(categories),
  modifierGroups: many(modifierGroups),
  cartItems: many(cartItems),
  orderIntentItems: many(orderIntentItems),
  orderFulfillments: many(orderFulfillments),
}));

export const storefrontsRelations = relations(storefronts, ({ one }) => ({
  tenant: one(tenants, {
    fields: [storefronts.tenantId],
    references: [tenants.id],
  }),
  primaryBrand: one(brands, {
    fields: [storefronts.primaryBrandId],
    references: [brands.id],
  }),
}));

export const locationsRelations = relations(locations, ({ one, many }) => ({
  tenant: one(tenants, {
    fields: [locations.tenantId],
    references: [tenants.id],
  }),
  brands: many(locationBrands),
  // DEL-24: commerce.
  carts: many(carts),
  orderIntents: many(orderIntents),
  orderFulfillments: many(orderFulfillments),
}));

export const locationBrandsRelations = relations(locationBrands, ({ one }) => ({
  location: one(locations, {
    fields: [locationBrands.locationId],
    references: [locations.id],
  }),
  brand: one(brands, {
    fields: [locationBrands.brandId],
    references: [brands.id],
  }),
}));

export const tenantEndUsersRelations = relations(tenantEndUsers, ({ one, many }) => ({
  tenant: one(tenants, {
    fields: [tenantEndUsers.tenantId],
    references: [tenants.id],
  }),
  accounts: many(tenantEndUserAccounts),
  sessions: many(tenantEndUserSessions),
  // DEL-24: commerce.
  carts: many(carts),
  orderIntents: many(orderIntents),
}));

export const tenantMembershipsRelations = relations(tenantMemberships, ({ one }) => ({
  user: one(platformUsers, {
    fields: [tenantMemberships.platformUserId],
    references: [platformUsers.id],
  }),
  tenant: one(tenants, {
    fields: [tenantMemberships.tenantId],
    references: [tenants.id],
  }),
}));

// ============================================================================
// COMMERCE RELATIONS (DEL-24)
// ============================================================================

export const menusRelations = relations(menus, ({ one, many }) => ({
  brand: one(brands, {
    fields: [menus.brandId],
    references: [brands.id],
  }),
  items: many(menuItems),
}));

export const menuItemsRelations = relations(menuItems, ({ one, many }) => ({
  menu: one(menus, {
    fields: [menuItems.menuId],
    references: [menus.id],
  }),
  // DEL-34 / X3: catalog. category is `one`; modifier groups are M:N via the
  // join table (Drizzle has no direct M:N).
  category: one(categories, {
    fields: [menuItems.categoryId],
    references: [categories.id],
  }),
  modifierGroups: many(menuItemModifierGroups),
  // No direct brand relation — chain via menu (per ADR-0012 / spec).
}));

// DEL-34 / X3: catalog relations.
export const categoriesRelations = relations(categories, ({ one, many }) => ({
  brand: one(brands, {
    fields: [categories.brandId],
    references: [brands.id],
  }),
  menuItems: many(menuItems),
}));

export const modifierGroupsRelations = relations(modifierGroups, ({ one, many }) => ({
  brand: one(brands, {
    fields: [modifierGroups.brandId],
    references: [brands.id],
  }),
  modifiers: many(modifiers),
  menuItems: many(menuItemModifierGroups),
}));

export const modifiersRelations = relations(modifiers, ({ one }) => ({
  group: one(modifierGroups, {
    fields: [modifiers.modifierGroupId],
    references: [modifierGroups.id],
  }),
}));

export const menuItemModifierGroupsRelations = relations(menuItemModifierGroups, ({ one }) => ({
  menuItem: one(menuItems, {
    fields: [menuItemModifierGroups.menuItemId],
    references: [menuItems.id],
  }),
  modifierGroup: one(modifierGroups, {
    fields: [menuItemModifierGroups.modifierGroupId],
    references: [modifierGroups.id],
  }),
}));

export const cartsRelations = relations(carts, ({ one, many }) => ({
  tenant: one(tenants, {
    fields: [carts.tenantId],
    references: [tenants.id],
  }),
  location: one(locations, {
    fields: [carts.locationId],
    references: [locations.id],
  }),
  tenantEndUser: one(tenantEndUsers, {
    fields: [carts.tenantEndUserId],
    references: [tenantEndUsers.id],
  }),
  items: many(cartItems),
}));

export const cartItemsRelations = relations(cartItems, ({ one }) => ({
  cart: one(carts, {
    fields: [cartItems.cartId],
    references: [carts.id],
  }),
  brand: one(brands, {
    fields: [cartItems.brandId],
    references: [brands.id],
  }),
  menuItem: one(menuItems, {
    fields: [cartItems.menuItemId],
    references: [menuItems.id],
  }),
}));

export const orderIntentsRelations = relations(orderIntents, ({ one, many }) => ({
  tenant: one(tenants, {
    fields: [orderIntents.tenantId],
    references: [tenants.id],
  }),
  location: one(locations, {
    fields: [orderIntents.locationId],
    references: [locations.id],
  }),
  // tenantEndUser is nullable — order_intents.tenant_end_user_id SET NULL on
  // single-user GDPR delete; relation typed accordingly.
  tenantEndUser: one(tenantEndUsers, {
    fields: [orderIntents.tenantEndUserId],
    references: [tenantEndUsers.id],
  }),
  items: many(orderIntentItems),
  fulfillments: many(orderFulfillments),
  modifications: many(orderModifications),
  payments: many(payments),
}));

export const orderIntentItemsRelations = relations(orderIntentItems, ({ one, many }) => ({
  orderIntent: one(orderIntents, {
    fields: [orderIntentItems.orderIntentId],
    references: [orderIntents.id],
  }),
  // brand is nullable — SET NULL on single-brand hard-delete (history
  // preserved via brand_name_snapshot).
  brand: one(brands, {
    fields: [orderIntentItems.brandId],
    references: [brands.id],
  }),
  fulfillmentItems: many(orderFulfillmentItems),
}));

export const orderFulfillmentsRelations = relations(orderFulfillments, ({ one, many }) => ({
  orderIntent: one(orderIntents, {
    fields: [orderFulfillments.orderIntentId],
    references: [orderIntents.id],
  }),
  tenant: one(tenants, {
    fields: [orderFulfillments.tenantId],
    references: [tenants.id],
  }),
  brand: one(brands, {
    fields: [orderFulfillments.brandId],
    references: [brands.id],
  }),
  location: one(locations, {
    fields: [orderFulfillments.locationId],
    references: [locations.id],
  }),
  items: many(orderFulfillmentItems),
}));

export const orderFulfillmentItemsRelations = relations(orderFulfillmentItems, ({ one }) => ({
  fulfillment: one(orderFulfillments, {
    fields: [orderFulfillmentItems.orderFulfillmentId],
    references: [orderFulfillments.id],
  }),
  intentItem: one(orderIntentItems, {
    fields: [orderFulfillmentItems.orderIntentItemId],
    references: [orderIntentItems.id],
  }),
}));

export const orderModificationsRelations = relations(orderModifications, ({ one, many }) => ({
  orderIntent: one(orderIntents, {
    fields: [orderModifications.orderIntentId],
    references: [orderIntents.id],
  }),
  // DEL-35: each refund writes its own modification row; the nullable FK lives
  // on refunds, so physically this is one-to-many.
  refunds: many(refunds),
}));

export const paymentsRelations = relations(payments, ({ one, many }) => ({
  tenant: one(tenants, {
    fields: [payments.tenantId],
    references: [tenants.id],
  }),
  orderIntent: one(orderIntents, {
    fields: [payments.orderIntentId],
    references: [orderIntents.id],
  }),
  refunds: many(refunds),
}));

export const refundsRelations = relations(refunds, ({ one }) => ({
  tenant: one(tenants, {
    fields: [refunds.tenantId],
    references: [tenants.id],
  }),
  payment: one(payments, {
    fields: [refunds.paymentId],
    references: [payments.id],
  }),
  // Nullable — SET NULL on modification cleanup.
  orderModification: one(orderModifications, {
    fields: [refunds.orderModificationId],
    references: [orderModifications.id],
  }),
}));
