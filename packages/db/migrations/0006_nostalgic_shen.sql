-- DEL-21: make tenant_end_user_sessions.current_brand_id NULLABLE per
-- ADR-0012 §"Session model (target)". Pure DROP NOT NULL — existing sessions
-- retain their UUID; no data loss. FK to brands(id) ON DELETE CASCADE and
-- indexes are unchanged. drizzle-kit output verified clean (no FK churn).
-- Spec: docs/specs/session-brand-optional.md
ALTER TABLE "tenant_end_user_sessions" ALTER COLUMN "current_brand_id" DROP NOT NULL;