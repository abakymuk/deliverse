/**
 * Inngest function-registration route.
 *
 * This is the ONLY place in the workspace that hosts Inngest function
 * definitions — per ADR-0009 decision #5, double-registration would
 * cause duplicate sends (Inngest's fan-out semantics aren't dedupe).
 *
 * Both apps' `inngest` clients are the same instance (from
 * `@rp/emails/inngest`); they may all call `inngest.send(...)`, but
 * only this route handler passes `functions` to `serve()`.
 *
 * `export const dynamic = 'force-dynamic'` is required: without it,
 * the App Router can statically optimize the route and miss
 * invocations from Inngest Cloud. `maxDuration = 300` raises the
 * per-invocation timeout to accommodate slow Resend sends + retries.
 *
 * Do NOT set `runtime = 'edge'` — `@rp/db` uses `postgres` which is
 * Node-only.
 */

import { functions as emailFunctions, inngest } from '@rp/emails/inngest';
import { functions as eventFunctions } from '@rp/events/inngest';
import { serve } from 'inngest/next';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

// Concatenate function arrays from all registry-owning packages. Each package
// exports its `functions` list; this route is the single mount point per
// ADR-0009 §5. New packages with Inngest functions add their array here.
const functions = [...emailFunctions, ...eventFunctions];

export const { GET, POST, PUT } = serve({ client: inngest, functions });
