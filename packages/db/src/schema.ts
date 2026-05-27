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
