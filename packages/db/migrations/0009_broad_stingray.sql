-- DEL-29: event_outbox + @rp/events package.
-- Outbox pattern for domain events; consumed by outbox-dispatcher Inngest cron
-- in @rp/events. New table only; no data backfill. RLS-ready: tenant_id direct FK.
--
-- created_at: wall-clock row creation. occurred_at: domain time of the event.
-- For freshly-emitted events they're within ms; backfilled/replayed events can
-- diverge by hours/days.
--
-- Partial unique index on (tenant_id, event_type, idempotency_key) WHERE
-- idempotency_key IS NOT NULL — enforces dedup for retried BA flows.
-- Pair with INSERT ... ON CONFLICT DO NOTHING in @rp/events writer.

CREATE TABLE "event_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"aggregate_type" text NOT NULL,
	"aggregate_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"event_version" integer DEFAULT 1 NOT NULL,
	"payload" jsonb NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" uuid,
	"idempotency_key" text,
	"causation_id" uuid,
	"correlation_id" uuid,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "event_outbox" ADD CONSTRAINT "event_outbox_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "event_outbox_pending_idx" ON "event_outbox" USING btree ("occurred_at") WHERE "event_outbox"."published_at" IS NULL;--> statement-breakpoint
CREATE INDEX "event_outbox_aggregate_idx" ON "event_outbox" USING btree ("tenant_id","aggregate_type","aggregate_id","occurred_at");--> statement-breakpoint
CREATE INDEX "event_outbox_event_type_idx" ON "event_outbox" USING btree ("tenant_id","event_type","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "event_outbox_idempotency_unique" ON "event_outbox" USING btree ("tenant_id","event_type","idempotency_key") WHERE "event_outbox"."idempotency_key" IS NOT NULL;