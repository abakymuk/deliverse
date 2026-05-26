/**
 * Inngest client — single shared instance for the workspace.
 *
 * Auto-connects to the local Inngest dev server on port 8288 when
 * `INNGEST_EVENT_KEY` is unset (per inngest-cli's `dev` mode), and to
 * Inngest Cloud when the key is present. Same instance is used both
 * for sending events (from any app/package) and for hosting functions
 * (only `apps/platform/src/app/api/inngest/route.ts` registers them —
 * ADR-0009 decision #5).
 */

import { Inngest } from 'inngest';

export const inngest = new Inngest({ id: 'rp-emails' });
