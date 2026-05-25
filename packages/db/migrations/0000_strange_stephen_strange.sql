CREATE TYPE "public"."tenant_role" AS ENUM('owner', 'manager', 'staff', 'viewer');--> statement-breakpoint
CREATE TYPE "public"."tenant_status" AS ENUM('active', 'suspended', 'pending_deletion');--> statement-breakpoint
CREATE TYPE "public"."verification_type" AS ENUM('otp_login', 'email_verify', 'password_reset');--> statement-breakpoint
CREATE TABLE "brands" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"branding_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "location_brands" (
	"location_id" uuid NOT NULL,
	"brand_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "location_brands_location_id_brand_id_pk" PRIMARY KEY("location_id","brand_id")
);
--> statement-breakpoint
CREATE TABLE "locations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"address_line1" text NOT NULL,
	"address_line2" text,
	"city" text NOT NULL,
	"state" text NOT NULL,
	"postal_code" text NOT NULL,
	"country" text NOT NULL,
	"latitude" text,
	"longitude" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "platform_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"platform_user_id" uuid NOT NULL,
	"provider_id" text NOT NULL,
	"account_id" text NOT NULL,
	"password" text,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"platform_user_id" uuid NOT NULL,
	"token" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform_users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"name" text,
	"email_verified_at" timestamp with time zone,
	"image_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "platform_verifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenant_end_user_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_end_user_id" uuid NOT NULL,
	"provider_id" text NOT NULL,
	"account_id" text NOT NULL,
	"password" text,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenant_end_user_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_end_user_id" uuid NOT NULL,
	"current_brand_id" uuid NOT NULL,
	"token" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenant_end_user_verifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"tenant_id" uuid NOT NULL,
	"brand_id" uuid,
	"type" "verification_type" NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenant_end_users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"email" text NOT NULL,
	"name" text,
	"email_verified_at" timestamp with time zone,
	"image_url" text,
	"phone" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "tenant_invitations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"email" text NOT NULL,
	"role" "tenant_role" NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"inviter_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenant_memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"platform_user_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"role" "tenant_role" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"logo" text,
	"status" "tenant_status" DEFAULT 'active' NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "brands" ADD CONSTRAINT "brands_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "location_brands" ADD CONSTRAINT "location_brands_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "location_brands" ADD CONSTRAINT "location_brands_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "locations" ADD CONSTRAINT "locations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_accounts" ADD CONSTRAINT "platform_accounts_platform_user_id_platform_users_id_fk" FOREIGN KEY ("platform_user_id") REFERENCES "public"."platform_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_sessions" ADD CONSTRAINT "platform_sessions_platform_user_id_platform_users_id_fk" FOREIGN KEY ("platform_user_id") REFERENCES "public"."platform_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_end_user_accounts" ADD CONSTRAINT "tenant_end_user_accounts_tenant_end_user_id_tenant_end_users_id_fk" FOREIGN KEY ("tenant_end_user_id") REFERENCES "public"."tenant_end_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_end_user_sessions" ADD CONSTRAINT "tenant_end_user_sessions_tenant_end_user_id_tenant_end_users_id_fk" FOREIGN KEY ("tenant_end_user_id") REFERENCES "public"."tenant_end_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_end_user_sessions" ADD CONSTRAINT "tenant_end_user_sessions_current_brand_id_brands_id_fk" FOREIGN KEY ("current_brand_id") REFERENCES "public"."brands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_end_user_verifications" ADD CONSTRAINT "tenant_end_user_verifications_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_end_user_verifications" ADD CONSTRAINT "tenant_end_user_verifications_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_end_users" ADD CONSTRAINT "tenant_end_users_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_invitations" ADD CONSTRAINT "tenant_invitations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_invitations" ADD CONSTRAINT "tenant_invitations_inviter_id_platform_users_id_fk" FOREIGN KEY ("inviter_id") REFERENCES "public"."platform_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_memberships" ADD CONSTRAINT "tenant_memberships_platform_user_id_platform_users_id_fk" FOREIGN KEY ("platform_user_id") REFERENCES "public"."platform_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_memberships" ADD CONSTRAINT "tenant_memberships_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "brands_slug_idx" ON "brands" USING btree ("slug") WHERE "brands"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "brands_tenant_idx" ON "brands" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "location_brands_brand_idx" ON "location_brands" USING btree ("brand_id");--> statement-breakpoint
CREATE INDEX "locations_tenant_idx" ON "locations" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "platform_accounts_provider_account_idx" ON "platform_accounts" USING btree ("provider_id","account_id");--> statement-breakpoint
CREATE INDEX "platform_accounts_user_idx" ON "platform_accounts" USING btree ("platform_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "platform_sessions_token_idx" ON "platform_sessions" USING btree ("token");--> statement-breakpoint
CREATE INDEX "platform_sessions_user_idx" ON "platform_sessions" USING btree ("platform_user_id");--> statement-breakpoint
CREATE INDEX "platform_sessions_expires_idx" ON "platform_sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "platform_users_email_idx" ON "platform_users" USING btree ("email") WHERE "platform_users"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "platform_verifications_identifier_idx" ON "platform_verifications" USING btree ("identifier");--> statement-breakpoint
CREATE INDEX "platform_verifications_expires_idx" ON "platform_verifications" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_end_user_accounts_provider_account_idx" ON "tenant_end_user_accounts" USING btree ("provider_id","account_id");--> statement-breakpoint
CREATE INDEX "tenant_end_user_accounts_user_idx" ON "tenant_end_user_accounts" USING btree ("tenant_end_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_end_user_sessions_token_idx" ON "tenant_end_user_sessions" USING btree ("token");--> statement-breakpoint
CREATE INDEX "tenant_end_user_sessions_user_idx" ON "tenant_end_user_sessions" USING btree ("tenant_end_user_id");--> statement-breakpoint
CREATE INDEX "tenant_end_user_sessions_brand_idx" ON "tenant_end_user_sessions" USING btree ("current_brand_id");--> statement-breakpoint
CREATE INDEX "tenant_end_user_sessions_expires_idx" ON "tenant_end_user_sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "tenant_end_user_verifications_tenant_id_idx" ON "tenant_end_user_verifications" USING btree ("tenant_id","identifier");--> statement-breakpoint
CREATE INDEX "tenant_end_user_verifications_expires_idx" ON "tenant_end_user_verifications" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_end_users_tenant_email_idx" ON "tenant_end_users" USING btree ("tenant_id","email") WHERE "tenant_end_users"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "tenant_end_users_tenant_idx" ON "tenant_end_users" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_invitations_pending_idx" ON "tenant_invitations" USING btree ("tenant_id","email") WHERE "tenant_invitations"."status" = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_memberships_user_tenant_idx" ON "tenant_memberships" USING btree ("platform_user_id","tenant_id");--> statement-breakpoint
CREATE INDEX "tenant_memberships_tenant_idx" ON "tenant_memberships" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "tenant_memberships_user_idx" ON "tenant_memberships" USING btree ("platform_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tenants_slug_idx" ON "tenants" USING btree ("slug") WHERE "tenants"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "tenants_status_idx" ON "tenants" USING btree ("status");