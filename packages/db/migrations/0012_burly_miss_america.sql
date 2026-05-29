CREATE TYPE "public"."modifier_selection_type" AS ENUM('single', 'multi');--> statement-breakpoint
CREATE TABLE "categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"brand_id" uuid NOT NULL,
	"name" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "menu_item_modifier_groups" (
	"menu_item_id" uuid NOT NULL,
	"modifier_group_id" uuid NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "menu_item_modifier_groups_menu_item_id_modifier_group_id_pk" PRIMARY KEY("menu_item_id","modifier_group_id")
);
--> statement-breakpoint
CREATE TABLE "modifier_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"brand_id" uuid NOT NULL,
	"name" text NOT NULL,
	"selection_type" "modifier_selection_type" NOT NULL,
	"min_select" integer DEFAULT 0 NOT NULL,
	"max_select" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "modifiers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"modifier_group_id" uuid NOT NULL,
	"name" text NOT NULL,
	"price_delta_cents" integer DEFAULT 0 NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "menu_items" ADD COLUMN "slug" text;--> statement-breakpoint
ALTER TABLE "menu_items" ADD COLUMN "category_id" uuid;--> statement-breakpoint
ALTER TABLE "categories" ADD CONSTRAINT "categories_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "menu_item_modifier_groups" ADD CONSTRAINT "menu_item_modifier_groups_menu_item_id_menu_items_id_fk" FOREIGN KEY ("menu_item_id") REFERENCES "public"."menu_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "menu_item_modifier_groups" ADD CONSTRAINT "menu_item_modifier_groups_modifier_group_id_modifier_groups_id_fk" FOREIGN KEY ("modifier_group_id") REFERENCES "public"."modifier_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "modifier_groups" ADD CONSTRAINT "modifier_groups_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "modifiers" ADD CONSTRAINT "modifiers_modifier_group_id_modifier_groups_id_fk" FOREIGN KEY ("modifier_group_id") REFERENCES "public"."modifier_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "categories_brand_idx" ON "categories" USING btree ("brand_id");--> statement-breakpoint
CREATE INDEX "menu_item_modifier_groups_modifier_group_idx" ON "menu_item_modifier_groups" USING btree ("modifier_group_id");--> statement-breakpoint
CREATE INDEX "modifier_groups_brand_idx" ON "modifier_groups" USING btree ("brand_id");--> statement-breakpoint
CREATE INDEX "modifiers_group_idx" ON "modifiers" USING btree ("modifier_group_id");--> statement-breakpoint
ALTER TABLE "menu_items" ADD CONSTRAINT "menu_items_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "menu_items_category_idx" ON "menu_items" USING btree ("category_id");