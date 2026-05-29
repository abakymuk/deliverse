/**
 * @rp/events Inngest registry. Functions exported here are added to the
 * `functions` array in apps/platform/src/app/api/inngest/route.ts.
 *
 * Per ADR-0009 §5: single registration point across the workspace.
 *
 * Future consumers (welcome-email on guest.signed_up, loyalty-accrue on
 * order_intent.placed, etc.) live under ./consumers/ and are appended here.
 */

import type { InngestFunction } from 'inngest';
import { outboxDispatcher } from './outbox-dispatcher';

export { inngest } from './client';
export { outboxDispatcher };

export const functions: InngestFunction.Any[] = [outboxDispatcher];
