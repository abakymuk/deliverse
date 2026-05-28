/**
 * Outbox dispatcher — Inngest cron function that drains unpublished rows
 * from event_outbox and republishes them via step.sendEvent.
 *
 * Three phases (must stay in this order — see README § Dispatcher):
 *   1. Claim   — SELECT ... FOR UPDATE SKIP LOCKED LIMIT BATCH_SIZE
 *                (no UPDATE yet; just locks the rows for the duration of the tx).
 *   2. Publish — one step.sendEvent per row with stable id `outbox:<row.id>`.
 *                Inngest dedups on this id across retries, so re-claims after
 *                mid-loop crashes don't double-publish.
 *   3. Mark    — single batch UPDATE event_outbox SET published_at = now()
 *                WHERE id IN (...).
 *
 * Publish-then-mark is the correct outbox shape. Mark-then-publish would
 * silently lose events on dispatcher crash (the row is "published" in the DB
 * but step.sendEvent never ran). Per the audit and DEL-29 plan.
 *
 * KNOBS (tighten when volume justifies):
 *   - BATCH_SIZE          — rows per dispatcher run.
 *   - concurrency.limit   — currently 1 (no two runs at once).
 *   - CRON                — env-driven via OUTBOX_DISPATCH_CRON. Default is
 *                            every 5 minutes. Inngest cron min granularity 1m.
 *                            If sustained throughput exceeds BATCH_SIZE per run,
 *                            tighten cron or raise BATCH_SIZE.
 *
 * REGISTRATION: this function is exported from packages/events/src/inngest/index.ts
 * and added to the `functions` array in apps/platform/src/app/api/inngest/route.ts.
 * Per ADR-0009 §5, registration is single-point.
 */

import { db } from '@rp/db';
import { eventOutbox } from '@rp/db/schema';
import { inArray, sql } from 'drizzle-orm';
import type { InngestFunction } from 'inngest';
import { inngest } from './client';

const BATCH_SIZE = 100;
const CRON = process.env.OUTBOX_DISPATCH_CRON ?? '*/5 * * * *';

type ClaimedRow = {
  id: string;
  tenant_id: string;
  event_type: string;
  event_version: number;
  payload: Record<string, unknown>;
  actor_type: string;
  actor_id: string | null;
  idempotency_key: string | null;
  correlation_id: string | null;
  causation_id: string | null;
  // ISO string after JSON serialization through step.run.
  occurred_at: string;
};

export const outboxDispatcher: InngestFunction.Any = inngest.createFunction(
  {
    id: 'outbox-dispatcher',
    name: 'Outbox dispatcher (claim → publish → mark)',
    concurrency: { limit: 1 },
    triggers: [{ cron: CRON }],
  },
  async ({ step, logger }) => {
    // Phase 1: claim. SELECT ... FOR UPDATE SKIP LOCKED keeps concurrent
    // dispatcher runs (under concurrency: 1 they can't coexist, but kept
    // here for safety against manual replays) from picking the same rows.
    const claimed = await step.run('claim', async () =>
      db.transaction(async (tx) => {
        const result = await tx.execute(sql`
          SELECT id, tenant_id, event_type, event_version, payload,
                 actor_type, actor_id, idempotency_key,
                 correlation_id, causation_id, occurred_at
            FROM event_outbox
           WHERE published_at IS NULL
           ORDER BY occurred_at ASC
           LIMIT ${BATCH_SIZE}
           FOR UPDATE SKIP LOCKED
        `);
        // postgres-js result shape: array-like rows directly on the result.
        // If a future Drizzle minor changes this to { rows: [...] }, swap to result.rows.
        return result as unknown as ClaimedRow[];
      }),
    );

    if (claimed.length === 0) {
      logger.info('outbox.dispatched', { count: 0 });
      return { count: 0 };
    }

    // Phase 2: publish. Each row → its own step.sendEvent. Stable id
    // `outbox:<row.id>` so Inngest dedups across re-claims after dispatcher
    // crash between phases 2 and 3.
    for (const row of claimed) {
      await step.sendEvent(`publish-${row.id}`, {
        name: row.event_type,
        id: `outbox:${row.id}`,
        data: {
          ...row.payload,
          _meta: {
            outboxId: row.id,
            eventVersion: row.event_version,
            occurredAt: row.occurred_at,
            tenantId: row.tenant_id,
            actorType: row.actor_type,
            actorId: row.actor_id,
            idempotencyKey: row.idempotency_key,
            correlationId: row.correlation_id,
            causationId: row.causation_id,
          },
        },
      });
    }

    // Phase 3: mark published. Single batch UPDATE.
    // If we crash before this completes, next dispatcher run re-claims and
    // Phase 2 republishes; Inngest dedups via the stable event id above.
    await step.run('mark-published', async () =>
      db
        .update(eventOutbox)
        .set({ publishedAt: new Date() })
        .where(
          inArray(
            eventOutbox.id,
            claimed.map((r: ClaimedRow) => r.id),
          ),
        ),
    );

    logger.info('outbox.dispatched', { count: claimed.length });
    return { count: claimed.length };
  },
);
