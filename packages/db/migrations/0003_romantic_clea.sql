-- DEL-9: OTP rate limiting infrastructure.
--
-- Hand-edited from drizzle-kit output to add the backfill UPDATE that sets
-- `last_requested_at = created_at` on existing rows. Without it, every
-- existing tenant_end_user_verifications row would have
-- `last_requested_at = migration_time` and our rate-limit lookup would
-- block all OTP requests for 60s after the migration runs in stg/prd.
--
-- See docs/specs/otp-rate-limiting.md.

CREATE TABLE "tenant_otp_lockouts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"identifier" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tenant_end_user_verifications" ADD COLUMN "last_requested_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint

-- Backfill: stamp historical rows with their original creation time so the
-- 60s rate-limit window doesn't inadvertently block requests immediately
-- after migration. Safe — new column default covers any rows inserted
-- after this UPDATE runs.
UPDATE "tenant_end_user_verifications" SET "last_requested_at" = "created_at";--> statement-breakpoint

ALTER TABLE "tenant_otp_lockouts" ADD CONSTRAINT "tenant_otp_lockouts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tenant_otp_lockouts_lookup_idx" ON "tenant_otp_lockouts" USING btree ("tenant_id","identifier","expires_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "tenant_end_user_verifications_rate_limit_idx" ON "tenant_end_user_verifications" USING btree ("tenant_id","identifier","type","last_requested_at" DESC NULLS LAST);