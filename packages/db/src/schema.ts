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

// Order lifecycle. Includes KDS-ready states ('preparing', 'ready') up
// front to avoid a future migration when the kitchen-display work begins,
// even though they're unread at DEL-24 PR time. 'completed' = handed off
// to the customer (pickup picked up, delivery delivered). 'cancelled' =
// no-go; orders are never hard-deleted — historical/audit record.
export const orderStatusEnum = pgEnum('order_status', [
  'pending',
  'confirmed',
  'preparing',
  'ready',
  'completed',
  'cancelled',
]);

// Fulfillment type, orthogonal to order_status. Order status describes
// kitchen lifecycle; fulfillment describes pickup vs delivery. A future
// `delivery_status` enum (e.g., unassigned|assigned|picked_up|delivered|
// failed) can be added separately without touching this enum.
export const fulfillmentTypeEnum = pgEnum('fulfillment_type', [
  'pickup',
  'delivery',
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
}, (t) => ({
  menuIdx: index('menu_items_menu_idx').on(t.menuId),
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

  // Untyped jsonb in v1; v2 may pin a shape like
  // Array<{ id, name, priceDelta }>.
  modifiersJson: jsonb('modifiers_json').$type<Record<string, unknown>>().notNull().default({}),

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
 * orders — submitted orders
 *
 * Append-only historical records. NO deletedAt — cancel via
 * status='cancelled'. NO brand_id ownership column (AC#3).
 *
 * tenant_end_user_id is NULLABLE + ON DELETE SET NULL so single-user GDPR
 * deletion preserves the order as an anonymous historical record. Tenant
 * hard-delete still cascades through orders via tenant_id CASCADE (full-
 * tenant GDPR cleanup).
 */
export const orders = pgTable('orders', {
  id: uuid('id').primaryKey().defaultRandom(),

  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' }),

  locationId: uuid('location_id')
    .notNull()
    .references(() => locations.id, { onDelete: 'cascade' }),

  // NULLABLE + SET NULL — preserves order history through single-user
  // GDPR delete. See spec § "Edge Cases" + § "Intentional Deviation".
  tenantEndUserId: uuid('tenant_end_user_id')
    .references(() => tenantEndUsers.id, { onDelete: 'set null' }),

  status: orderStatusEnum('status').notNull().default('pending'),

  // No default — every order must declare its fulfillment mode at create.
  fulfillmentType: fulfillmentTypeEnum('fulfillment_type').notNull(),

  subtotalCents: integer('subtotal_cents').notNull(),
  taxCents: integer('tax_cents').notNull().default(0),
  feeCents: integer('fee_cents').notNull().default(0),
  tipCents: integer('tip_cents').notNull().default(0),
  totalCents: integer('total_cents').notNull(),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  tenantIdx: index('orders_tenant_idx').on(t.tenantId),
  userIdx: index('orders_user_idx').on(t.tenantEndUserId),
  locationIdx: index('orders_location_idx').on(t.locationId),
  statusIdx: index('orders_status_idx').on(t.status),
  createdAtIdx: index('orders_created_at_idx').on(t.createdAt),
  // Composite for tenant-scoped recency queries (admin "recent orders"
  // view, cron jobs that walk per-tenant by created_at, etc.).
  tenantCreatedAtIdx: index('orders_tenant_created_at_idx').on(t.tenantId, t.createdAt.desc()),
}));

/**
 * order_line_items — immutable line items inside an order
 *
 * brand_id is NULLABLE + ON DELETE SET NULL — intentional deviation from
 * AC#4 to preserve audit history through single-brand removal.
 * brand_name_snapshot carries the brand identity forward when the FK is
 * SET NULL. cart_items.brand_id stays NOT NULL (transient row).
 *
 * menu_item_id_snapshot is a soft pointer (no .references()) — survives
 * menu_item hard-delete. name_snapshot + modifiers_snapshot_json carry
 * the line's content forward.
 *
 * No timestamps, no soft delete — created with the order and never
 * edited.
 */
export const orderLineItems = pgTable('order_line_items', {
  id: uuid('id').primaryKey().defaultRandom(),

  orderId: uuid('order_id')
    .notNull()
    .references(() => orders.id, { onDelete: 'cascade' }),

  // NULLABLE + SET NULL — see header comment.
  brandId: uuid('brand_id')
    .references(() => brands.id, { onDelete: 'set null' }),

  // Required so analytics can still attribute the line to a brand by name
  // after a brand hard-delete clears the FK.
  brandNameSnapshot: text('brand_name_snapshot').notNull(),

  // Soft pointer: no .references(), no FK integrity. Survives menu_item
  // hard-delete. Orphan IDs are acceptable for a snapshot.
  menuItemIdSnapshot: uuid('menu_item_id_snapshot'),

  nameSnapshot: text('name_snapshot').notNull(),

  quantity: integer('quantity').notNull(),

  modifiersSnapshotJson: jsonb('modifiers_snapshot_json').$type<Record<string, unknown>>().notNull().default({}),

  unitPriceCents: integer('unit_price_cents').notNull(),
  totalCents: integer('total_cents').notNull(),
}, (t) => ({
  orderIdx: index('order_line_items_order_idx').on(t.orderId),
  brandIdx: index('order_line_items_brand_idx').on(t.brandId),
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

export type Cart = typeof carts.$inferSelect;
export type NewCart = typeof carts.$inferInsert;

export type CartItem = typeof cartItems.$inferSelect;
export type NewCartItem = typeof cartItems.$inferInsert;

export type Order = typeof orders.$inferSelect;
export type NewOrder = typeof orders.$inferInsert;

export type OrderLineItem = typeof orderLineItems.$inferSelect;
export type NewOrderLineItem = typeof orderLineItems.$inferInsert;

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
  orders: many(orders),
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
  cartItems: many(cartItems),
  orderLineItems: many(orderLineItems),
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
  orders: many(orders),
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
  orders: many(orders),
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

export const menuItemsRelations = relations(menuItems, ({ one }) => ({
  menu: one(menus, {
    fields: [menuItems.menuId],
    references: [menus.id],
  }),
  // No direct brand relation — chain via menu (per ADR-0012 / spec).
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

export const ordersRelations = relations(orders, ({ one, many }) => ({
  tenant: one(tenants, {
    fields: [orders.tenantId],
    references: [tenants.id],
  }),
  location: one(locations, {
    fields: [orders.locationId],
    references: [locations.id],
  }),
  // tenantEndUser is nullable — orders.tenant_end_user_id SET NULL on
  // single-user GDPR delete; relation typed accordingly.
  tenantEndUser: one(tenantEndUsers, {
    fields: [orders.tenantEndUserId],
    references: [tenantEndUsers.id],
  }),
  lineItems: many(orderLineItems),
}));

export const orderLineItemsRelations = relations(orderLineItems, ({ one }) => ({
  order: one(orders, {
    fields: [orderLineItems.orderId],
    references: [orders.id],
  }),
  // brand is nullable — order_line_items.brand_id SET NULL on single-brand
  // hard-delete (history preserved via brand_name_snapshot).
  brand: one(brands, {
    fields: [orderLineItems.brandId],
    references: [brands.id],
  }),
}));
