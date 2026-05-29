CREATE TYPE "public"."payment_status" AS ENUM('pending', 'captured', 'partially_refunded', 'refunded', 'failed', 'canceled');--> statement-breakpoint
CREATE TYPE "public"."refund_status" AS ENUM('pending', 'succeeded', 'failed', 'canceled');--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"order_intent_id" uuid NOT NULL,
	"provider" text DEFAULT 'stripe' NOT NULL,
	"external_id" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"currency" text DEFAULT 'usd' NOT NULL,
	"application_fee_cents" integer,
	"status" "payment_status" NOT NULL,
	"captured_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "refunds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"payment_id" uuid NOT NULL,
	"order_modification_id" uuid,
	"provider" text DEFAULT 'stripe' NOT NULL,
	"external_id" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"status" "refund_status" NOT NULL,
	"transfer_reversed" boolean DEFAULT false NOT NULL,
	"application_fee_refunded_cents" integer,
	"processed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "stripe_account_id" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "stripe_charges_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_order_intent_id_order_intents_id_fk" FOREIGN KEY ("order_intent_id") REFERENCES "public"."order_intents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_order_modification_id_order_modifications_id_fk" FOREIGN KEY ("order_modification_id") REFERENCES "public"."order_modifications"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "payments_provider_external_id_unique" ON "payments" USING btree ("provider","external_id");--> statement-breakpoint
CREATE INDEX "payments_tenant_created_at_idx" ON "payments" USING btree ("tenant_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "payments_order_intent_idx" ON "payments" USING btree ("order_intent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "refunds_provider_external_id_unique" ON "refunds" USING btree ("provider","external_id");--> statement-breakpoint
CREATE INDEX "refunds_payment_idx" ON "refunds" USING btree ("payment_id");--> statement-breakpoint
CREATE INDEX "refunds_tenant_created_at_idx" ON "refunds" USING btree ("tenant_id","created_at" DESC NULLS LAST);