ALTER TABLE "platform_users" ALTER COLUMN "name" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "tenant_end_users" ALTER COLUMN "name" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "platform_sessions" ADD COLUMN "active_organization_id" uuid;--> statement-breakpoint
ALTER TABLE "platform_users" ADD COLUMN "email_verified" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "tenant_end_users" ADD COLUMN "email_verified" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "platform_sessions" ADD CONSTRAINT "platform_sessions_active_organization_id_tenants_id_fk" FOREIGN KEY ("active_organization_id") REFERENCES "public"."tenants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "platform_sessions_active_org_idx" ON "platform_sessions" USING btree ("active_organization_id");--> statement-breakpoint
ALTER TABLE "platform_users" DROP COLUMN "email_verified_at";--> statement-breakpoint
ALTER TABLE "tenant_end_users" DROP COLUMN "email_verified_at";