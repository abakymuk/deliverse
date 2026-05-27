-- DEL-19: introduce first-class storefronts entity per ADR-0012.
--
-- Hand-edited from drizzle-kit output to add the backfill INSERT at the
-- bottom (drizzle-kit doesn't emit data migrations). One row per LIVE
-- brand (deleted_at IS NULL AND is_active = true) with type='brand',
-- primary_brand_id=brand.id, slug=brand.slug.
--
-- Strictly additive — routing/auth/UI are untouched. DEL-20+ will swap
-- the storefront resolver onto this table.
--
-- See docs/specs/storefronts-model.md.

CREATE TYPE "public"."storefront_type" AS ENUM('brand', 'tenant');--> statement-breakpoint
CREATE TABLE "storefronts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"type" "storefront_type" NOT NULL,
	"primary_brand_id" uuid,
	"branding_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "storefronts_type_primary_brand_check" CHECK (("storefronts"."type" = 'brand' AND "storefronts"."primary_brand_id" IS NOT NULL) OR ("storefronts"."type" = 'tenant' AND "storefronts"."primary_brand_id" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "storefronts" ADD CONSTRAINT "storefronts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storefronts" ADD CONSTRAINT "storefronts_primary_brand_id_brands_id_fk" FOREIGN KEY ("primary_brand_id") REFERENCES "public"."brands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "storefronts_slug_idx" ON "storefronts" USING btree ("slug") WHERE "storefronts"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "storefronts_tenant_idx" ON "storefronts" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "storefronts_primary_brand_idx" ON "storefronts" USING btree ("primary_brand_id");--> statement-breakpoint

-- Backfill: one storefront row per LIVE brand. Matches how the storefront
-- resolver treats "live" today (deleted_at IS NULL AND is_active = true).
-- Inactive brands get a storefront only when reactivated via a later admin
-- path. The NOT EXISTS guard keeps the INSERT safe to rerun in isolation
-- if drizzle's __drizzle_migrations tracking ever hiccups.
INSERT INTO "storefronts" (
  "tenant_id", "slug", "name", "type", "primary_brand_id",
  "branding_json", "is_active", "created_at", "updated_at"
)
SELECT
  b."tenant_id", b."slug", b."name", 'brand', b."id",
  b."branding_json", b."is_active", b."created_at", now()
FROM "brands" b
WHERE b."deleted_at" IS NULL
  AND b."is_active" = true
  AND NOT EXISTS (
    SELECT 1 FROM "storefronts" s
    WHERE s."primary_brand_id" = b."id" AND s."deleted_at" IS NULL
  );