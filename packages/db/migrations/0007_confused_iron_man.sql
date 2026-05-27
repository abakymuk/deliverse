-- DEL-24: introduce commerce schema (menus, menu_items, carts, cart_items,
-- orders, order_line_items) per ADR-0012 §"Commerce model".
--
-- Drizzle-kit output. No backfill needed — all tables are new and no
-- application code reads from them at end of issue.
--
-- Data-retention policy:
--   - Tenant cascade wipes everything (GDPR full-tenant cleanup).
--   - orders.tenant_end_user_id is SET NULL — preserves order history
--     through single-user GDPR anonymization (right-to-be-forgotten).
--   - order_line_items.brand_id is SET NULL + brand_name_snapshot —
--     preserves audit/analytics history through single-brand removal
--     (intentional deviation from AC#4; cart_items.brand_id stays
--     NOT NULL CASCADE since cart items are transient).
--
-- One migration, not 2-3 — repo precedent (DEL-19, DEL-21) is one
-- migration per Linear issue; drizzle-kit output is clean; the repo is
-- forward-fix-only. Intentional deviation from AC#2 body documented in
-- the spec.
--
-- Strictly additive. DEL-25 adds the food-hall UI; later issues add
-- the checkout flow.
--
-- Spec: docs/specs/commerce-schema-v1.md

CREATE TYPE "public"."cart_status" AS ENUM('active', 'abandoned', 'converted');--> statement-breakpoint
CREATE TYPE "public"."fulfillment_type" AS ENUM('pickup', 'delivery');--> statement-breakpoint
CREATE TYPE "public"."order_status" AS ENUM('pending', 'confirmed', 'preparing', 'ready', 'completed', 'cancelled');--> statement-breakpoint
CREATE TABLE "cart_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cart_id" uuid NOT NULL,
	"brand_id" uuid NOT NULL,
	"menu_item_id" uuid NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL,
	"modifiers_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"unit_price_cents" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "carts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"tenant_end_user_id" uuid NOT NULL,
	"status" "cart_status" DEFAULT 'active' NOT NULL,
	"fulfillment_type" "fulfillment_type" DEFAULT 'pickup' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "menu_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"menu_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"price_cents" integer NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "menus" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"brand_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "order_line_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"brand_id" uuid,
	"brand_name_snapshot" text NOT NULL,
	"menu_item_id_snapshot" uuid,
	"name_snapshot" text NOT NULL,
	"quantity" integer NOT NULL,
	"modifiers_snapshot_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"unit_price_cents" integer NOT NULL,
	"total_cents" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"tenant_end_user_id" uuid,
	"status" "order_status" DEFAULT 'pending' NOT NULL,
	"fulfillment_type" "fulfillment_type" NOT NULL,
	"subtotal_cents" integer NOT NULL,
	"tax_cents" integer DEFAULT 0 NOT NULL,
	"fee_cents" integer DEFAULT 0 NOT NULL,
	"tip_cents" integer DEFAULT 0 NOT NULL,
	"total_cents" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cart_items" ADD CONSTRAINT "cart_items_cart_id_carts_id_fk" FOREIGN KEY ("cart_id") REFERENCES "public"."carts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cart_items" ADD CONSTRAINT "cart_items_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cart_items" ADD CONSTRAINT "cart_items_menu_item_id_menu_items_id_fk" FOREIGN KEY ("menu_item_id") REFERENCES "public"."menu_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "carts" ADD CONSTRAINT "carts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "carts" ADD CONSTRAINT "carts_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "carts" ADD CONSTRAINT "carts_tenant_end_user_id_tenant_end_users_id_fk" FOREIGN KEY ("tenant_end_user_id") REFERENCES "public"."tenant_end_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "menu_items" ADD CONSTRAINT "menu_items_menu_id_menus_id_fk" FOREIGN KEY ("menu_id") REFERENCES "public"."menus"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "menus" ADD CONSTRAINT "menus_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_line_items" ADD CONSTRAINT "order_line_items_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_line_items" ADD CONSTRAINT "order_line_items_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_tenant_end_user_id_tenant_end_users_id_fk" FOREIGN KEY ("tenant_end_user_id") REFERENCES "public"."tenant_end_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cart_items_cart_idx" ON "cart_items" USING btree ("cart_id");--> statement-breakpoint
CREATE INDEX "cart_items_brand_idx" ON "cart_items" USING btree ("brand_id");--> statement-breakpoint
CREATE INDEX "cart_items_menu_item_idx" ON "cart_items" USING btree ("menu_item_id");--> statement-breakpoint
CREATE INDEX "carts_tenant_idx" ON "carts" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "carts_user_idx" ON "carts" USING btree ("tenant_end_user_id");--> statement-breakpoint
CREATE INDEX "carts_location_idx" ON "carts" USING btree ("location_id");--> statement-breakpoint
CREATE INDEX "carts_status_idx" ON "carts" USING btree ("status");--> statement-breakpoint
CREATE INDEX "menu_items_menu_idx" ON "menu_items" USING btree ("menu_id");--> statement-breakpoint
CREATE INDEX "menus_brand_idx" ON "menus" USING btree ("brand_id");--> statement-breakpoint
CREATE INDEX "order_line_items_order_idx" ON "order_line_items" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "order_line_items_brand_idx" ON "order_line_items" USING btree ("brand_id");--> statement-breakpoint
CREATE INDEX "orders_tenant_idx" ON "orders" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "orders_user_idx" ON "orders" USING btree ("tenant_end_user_id");--> statement-breakpoint
CREATE INDEX "orders_location_idx" ON "orders" USING btree ("location_id");--> statement-breakpoint
CREATE INDEX "orders_status_idx" ON "orders" USING btree ("status");--> statement-breakpoint
CREATE INDEX "orders_created_at_idx" ON "orders" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "orders_tenant_created_at_idx" ON "orders" USING btree ("tenant_id","created_at" DESC NULLS LAST);