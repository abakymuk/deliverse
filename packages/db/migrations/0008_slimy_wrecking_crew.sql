-- Hand-edited from drizzle-kit output to support a backfill step.
-- drizzle-kit emits ADD COLUMN ... NOT NULL in one statement, which would
-- fail on existing rows. Split into nullable-add → backfill → SET NOT NULL,
-- matching the DEL-12 pattern (0002_polite_ego.sql) and DEL-21
-- (0006_nostalgic_shen.sql) precedents.
--
-- Spec: docs/specs/session-model-scoped.md. Closes the cross-tenant
-- cookie-replay defense-in-depth gap surfaced during DEL-26.

-- Step 1: add nullable tenant_id column. Existing rows get NULL initially.
ALTER TABLE "tenant_end_user_sessions" ADD COLUMN "tenant_id" uuid;--> statement-breakpoint

-- Step 2: add FK constraint. Cascade matches the existing tenant_end_user_id
-- cascade — tenant hard-delete already removes user rows, which cascades
-- to sessions through tenant_end_user_id; this second path keeps the
-- semantics correct if a session ever exists with a NULL tenant_end_user_id
-- (currently impossible per the FK, but the schema is defensive).
ALTER TABLE "tenant_end_user_sessions" ADD CONSTRAINT "tenant_end_user_sessions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

-- Step 3: backfill from the joined user row. Idempotent — only fills NULLs,
-- safe to re-run. NOT EXISTS not needed because the WHERE filters by
-- IS NULL.
UPDATE "tenant_end_user_sessions" AS s
SET "tenant_id" = u."tenant_id"
FROM "tenant_end_users" AS u
WHERE s."tenant_end_user_id" = u."id"
  AND s."tenant_id" IS NULL;--> statement-breakpoint

-- Step 4: lock down NOT NULL. Fails loudly if any session row still has
-- NULL tenant_id (which would indicate an orphaned session — should be
-- impossible given tenant_end_user_id NOT NULL + FK to tenant_end_users).
ALTER TABLE "tenant_end_user_sessions" ALTER COLUMN "tenant_id" SET NOT NULL;--> statement-breakpoint

-- Step 5: scan-friendly index for the wrapped adapter's tenant predicate.
CREATE INDEX "tenant_end_user_sessions_tenant_idx" ON "tenant_end_user_sessions" USING btree ("tenant_id");
