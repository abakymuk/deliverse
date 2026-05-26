-- DEL-12: tenant scoping for `tenant_end_user_accounts` so the same OAuth
-- provider+account_id can link to different tenant_end_users across tenants.
--
-- Hand-edited from drizzle-kit output to:
--   1. ADD COLUMN nullable, then backfill from FK user before SET NOT NULL.
--      (Existing rows on stg + prd from DEL-15 smoke would have failed an
--      immediate NOT NULL ADD COLUMN. Pre-migration orphan check confirmed
--      0 orphans on both envs — every row's FK user has a tenant_id.)
--   2. CREATE the new (looser) tenant-scoped unique BEFORE dropping the old
--      (stricter) global unique. The old unique implies the new — no chance
--      of duplicate-key failure on the new index. Avoids any window without
--      uniqueness if the migration runner ever stops wrapping in a single tx.
--
-- See docs/specs/del-12-account-tenant-scoping.md.

ALTER TABLE "tenant_end_user_accounts" ADD COLUMN "tenant_id" uuid;--> statement-breakpoint

-- Backfill tenant_id from the FK user row. Safe — orphan check returned 0
-- on both stg and prd before this PR merged.
UPDATE "tenant_end_user_accounts" a
SET "tenant_id" = u."tenant_id"
FROM "tenant_end_users" u
WHERE u."id" = a."tenant_end_user_id";--> statement-breakpoint

ALTER TABLE "tenant_end_user_accounts" ALTER COLUMN "tenant_id" SET NOT NULL;--> statement-breakpoint

ALTER TABLE "tenant_end_user_accounts" ADD CONSTRAINT "tenant_end_user_accounts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

CREATE UNIQUE INDEX "tenant_end_user_accounts_tenant_provider_account_idx" ON "tenant_end_user_accounts" USING btree ("tenant_id","provider_id","account_id");--> statement-breakpoint

DROP INDEX "tenant_end_user_accounts_provider_account_idx";
