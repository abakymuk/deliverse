/**
 * Inngest client re-export — uses the single workspace-shared instance
 * defined in @rp/emails. Per ADR-0009 §5, there is exactly ONE Inngest
 * client across the workspace and exactly ONE registration route
 * (apps/platform/src/app/api/inngest/route.ts).
 *
 * Imports from the narrow `./inngest/client` subpath (not the full
 * `./inngest` barrel) to avoid pulling @rp/emails' React Email templates
 * into @rp/events' TypeScript compilation — those need JSX support which
 * @rp/events' tsconfig doesn't enable.
 */

export { inngest } from '@rp/emails/inngest/client';
