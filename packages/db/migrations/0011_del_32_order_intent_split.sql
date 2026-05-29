-- DEL-32 / X1 — Order Intent / Fulfillment split.
--
-- Hand-written: `drizzle-kit generate` prompts on rename-vs-create in a
-- non-TTY shell. The matching snapshot (meta/0011_snapshot.json) was produced
-- non-interactively via drizzle-kit/api `generateDrizzleJson`.
--
-- Order: create enums + tables + FKs + indexes → backfill from the old
-- orders / order_line_items → assert the backfill is 1:1 → drop the old
-- tables + order_status enum. The whole file runs in one migrate() tx, so the
-- assertion aborts (rolls back) everything on a backfill mismatch.

CREATE TYPE "public"."order_intent_status" AS ENUM('placed', 'cancelled');
--> statement-breakpoint
CREATE TYPE "public"."fulfillment_status" AS ENUM('queued', 'preparing', 'ready', 'completed', 'cancelled');
--> statement-breakpoint
CREATE TYPE "public"."actor_type" AS ENUM('tenant_end_user', 'platform_user', 'service_account', 'agent', 'system');
--> statement-breakpoint
-- Additive enum value (pickup|delivery → +dine_in). Allowed inside the
-- migrate() tx on PG12+/Neon; the new value is never USED in this tx (backfill
-- copies the existing pickup/delivery values only).
ALTER TYPE "public"."fulfillment_type" ADD VALUE 'dine_in';
--> statement-breakpoint
CREATE TABLE "order_intents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"tenant_end_user_id" uuid,
	"channel" text DEFAULT 'storefront' NOT NULL,
	"placed_by_actor_type" "actor_type" NOT NULL,
	"placed_by_actor_id" uuid,
	"idempotency_key" text,
	"subtotal_cents" integer NOT NULL,
	"tax_cents" integer DEFAULT 0 NOT NULL,
	"fee_cents" integer DEFAULT 0 NOT NULL,
	"tip_cents" integer DEFAULT 0 NOT NULL,
	"total_cents" integer NOT NULL,
	"status" "order_intent_status" DEFAULT 'placed' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "order_intent_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_intent_id" uuid NOT NULL,
	"brand_id" uuid,
	"brand_name_snapshot" text NOT NULL,
	"menu_item_id_snapshot" uuid,
	"name_snapshot" text NOT NULL,
	"quantity" integer NOT NULL,
	"modifiers_snapshot_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"unit_price_cents" integer NOT NULL,
	"total_cents" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "order_fulfillments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_intent_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"brand_id" uuid,
	"brand_name_snapshot" text NOT NULL,
	"location_id" uuid NOT NULL,
	"fulfillment_type" "fulfillment_type" NOT NULL,
	"status" "fulfillment_status" DEFAULT 'queued' NOT NULL,
	"estimated_ready_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "order_fulfillment_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_fulfillment_id" uuid NOT NULL,
	"order_intent_item_id" uuid NOT NULL,
	"quantity" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "order_modifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_intent_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"actor_type" "actor_type" NOT NULL,
	"actor_id" uuid,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"financial_delta_cents" integer DEFAULT 0 NOT NULL,
	"applied_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "order_intents" ADD CONSTRAINT "order_intents_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "order_intents" ADD CONSTRAINT "order_intents_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "order_intents" ADD CONSTRAINT "order_intents_tenant_end_user_id_tenant_end_users_id_fk" FOREIGN KEY ("tenant_end_user_id") REFERENCES "public"."tenant_end_users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "order_intent_items" ADD CONSTRAINT "order_intent_items_order_intent_id_order_intents_id_fk" FOREIGN KEY ("order_intent_id") REFERENCES "public"."order_intents"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "order_intent_items" ADD CONSTRAINT "order_intent_items_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "order_fulfillments" ADD CONSTRAINT "order_fulfillments_order_intent_id_order_intents_id_fk" FOREIGN KEY ("order_intent_id") REFERENCES "public"."order_intents"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "order_fulfillments" ADD CONSTRAINT "order_fulfillments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "order_fulfillments" ADD CONSTRAINT "order_fulfillments_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "order_fulfillments" ADD CONSTRAINT "order_fulfillments_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "order_fulfillment_items" ADD CONSTRAINT "order_fulfillment_items_order_fulfillment_id_order_fulfillments_id_fk" FOREIGN KEY ("order_fulfillment_id") REFERENCES "public"."order_fulfillments"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "order_fulfillment_items" ADD CONSTRAINT "order_fulfillment_items_order_intent_item_id_order_intent_items_id_fk" FOREIGN KEY ("order_intent_item_id") REFERENCES "public"."order_intent_items"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "order_modifications" ADD CONSTRAINT "order_modifications_order_intent_id_order_intents_id_fk" FOREIGN KEY ("order_intent_id") REFERENCES "public"."order_intents"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "order_intents_tenant_created_at_idx" ON "order_intents" USING btree ("tenant_id","created_at" DESC NULLS LAST);
--> statement-breakpoint
CREATE INDEX "order_intents_user_idx" ON "order_intents" USING btree ("tenant_end_user_id");
--> statement-breakpoint
CREATE INDEX "order_intents_location_idx" ON "order_intents" USING btree ("location_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "order_intents_idempotency_unique" ON "order_intents" USING btree ("tenant_id","idempotency_key") WHERE "order_intents"."idempotency_key" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "order_intent_items_intent_idx" ON "order_intent_items" USING btree ("order_intent_id");
--> statement-breakpoint
CREATE INDEX "order_intent_items_brand_idx" ON "order_intent_items" USING btree ("brand_id");
--> statement-breakpoint
CREATE INDEX "order_fulfillments_intent_idx" ON "order_fulfillments" USING btree ("order_intent_id");
--> statement-breakpoint
CREATE INDEX "order_fulfillments_tenant_location_status_idx" ON "order_fulfillments" USING btree ("tenant_id","location_id","status");
--> statement-breakpoint
CREATE INDEX "order_fulfillment_items_fulfillment_idx" ON "order_fulfillment_items" USING btree ("order_fulfillment_id");
--> statement-breakpoint
CREATE INDEX "order_fulfillment_items_intent_item_idx" ON "order_fulfillment_items" USING btree ("order_intent_item_id");
--> statement-breakpoint
CREATE INDEX "order_modifications_intent_idx" ON "order_modifications" USING btree ("order_intent_id");
--> statement-breakpoint
-- ----------------------------------------------------------------------------
-- Backfill from the old orders / order_line_items (hand-added). prd has zero
-- order rows; dev/stg have a handful. Reuses old ids so order_id → intent id.
-- ----------------------------------------------------------------------------
INSERT INTO "order_intents" (
	"id", "tenant_id", "location_id", "tenant_end_user_id", "channel",
	"placed_by_actor_type", "placed_by_actor_id", "idempotency_key",
	"subtotal_cents", "tax_cents", "fee_cents", "tip_cents", "total_cents",
	"status", "created_at", "updated_at"
)
SELECT
	o."id", o."tenant_id", o."location_id", o."tenant_end_user_id", 'storefront',
	(CASE WHEN o."tenant_end_user_id" IS NOT NULL THEN 'tenant_end_user' ELSE 'system' END)::"actor_type",
	o."tenant_end_user_id",
	NULL,
	o."subtotal_cents", o."tax_cents", o."fee_cents", o."tip_cents", o."total_cents",
	(CASE WHEN o."status" = 'cancelled' THEN 'cancelled' ELSE 'placed' END)::"order_intent_status",
	o."created_at", o."updated_at"
FROM "orders" o;
--> statement-breakpoint
INSERT INTO "order_intent_items" (
	"id", "order_intent_id", "brand_id", "brand_name_snapshot",
	"menu_item_id_snapshot", "name_snapshot", "quantity",
	"modifiers_snapshot_json", "unit_price_cents", "total_cents"
)
SELECT
	li."id", li."order_id", li."brand_id", li."brand_name_snapshot",
	li."menu_item_id_snapshot", li."name_snapshot", li."quantity",
	li."modifiers_snapshot_json", li."unit_price_cents", li."total_cents"
FROM "order_line_items" li;
--> statement-breakpoint
-- One fulfillment per (intent, distinct brand). Old order status maps into the
-- fulfillment lifecycle (pending/confirmed → queued).
INSERT INTO "order_fulfillments" (
	"id", "order_intent_id", "tenant_id", "brand_id", "brand_name_snapshot",
	"location_id", "fulfillment_type", "status"
)
SELECT
	gen_random_uuid(), o."id", o."tenant_id", li."brand_id",
	MIN(li."brand_name_snapshot"),
	o."location_id", o."fulfillment_type",
	(CASE o."status"
		WHEN 'preparing' THEN 'preparing'
		WHEN 'ready' THEN 'ready'
		WHEN 'completed' THEN 'completed'
		WHEN 'cancelled' THEN 'cancelled'
		ELSE 'queued'
	END)::"fulfillment_status"
FROM "orders" o
JOIN "order_line_items" li ON li."order_id" = o."id"
GROUP BY o."id", o."tenant_id", li."brand_id", o."location_id", o."fulfillment_type", o."status";
--> statement-breakpoint
-- Map each intent item into its brand's fulfillment ticket (NULL brand matches
-- the NULL-brand fulfillment via IS NOT DISTINCT FROM).
INSERT INTO "order_fulfillment_items" ("id", "order_fulfillment_id", "order_intent_item_id", "quantity")
SELECT gen_random_uuid(), f."id", ii."id", ii."quantity"
FROM "order_intent_items" ii
JOIN "order_fulfillments" f
	ON f."order_intent_id" = ii."order_intent_id"
	AND f."brand_id" IS NOT DISTINCT FROM ii."brand_id";
--> statement-breakpoint
-- Assert the backfill is 1:1 BEFORE destroying the source tables. A mismatch
-- RAISEs, which rolls back the whole migration tx (tables never dropped).
DO $$
DECLARE
	v_orders bigint; v_intents bigint; v_lines bigint; v_items bigint;
BEGIN
	SELECT count(*) INTO v_orders FROM "orders";
	SELECT count(*) INTO v_intents FROM "order_intents";
	SELECT count(*) INTO v_lines FROM "order_line_items";
	SELECT count(*) INTO v_items FROM "order_intent_items";
	IF v_intents <> v_orders THEN
		RAISE EXCEPTION 'X1 backfill mismatch: order_intents=% vs orders=%', v_intents, v_orders;
	END IF;
	IF v_items <> v_lines THEN
		RAISE EXCEPTION 'X1 backfill mismatch: order_intent_items=% vs order_line_items=%', v_items, v_lines;
	END IF;
END $$;
--> statement-breakpoint
DROP TABLE "order_line_items";
--> statement-breakpoint
DROP TABLE "orders";
--> statement-breakpoint
DROP TYPE "public"."order_status";
