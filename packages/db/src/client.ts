/**
 * Database client — singleton Postgres connection
 *
 * Used by all apps via @rp/db. Never instantiate postgres() directly in apps.
 *
 * For serverless (Vercel), we use `postgres` driver with prepare: false
 * to avoid statement cache issues on cold starts.
 */

import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error('DATABASE_URL is not set');
}

// Configuration tuned for serverless:
// - prepare: false → no statement caching (cold start friendly)
// - max: 1 → single connection per serverless instance
// - idle_timeout: 20 → release connections quickly
const queryClient = postgres(connectionString, {
  prepare: false,
  max: 1,
  idle_timeout: 20,
});

export const db = drizzle(queryClient, { schema });

export type Database = typeof db;

/**
 * Transaction type — the tx handle passed into `db.transaction(async (tx) => ...)`.
 *
 * Derived from Database['transaction']'s callback signature so it stays in sync
 * with whichever Drizzle version is pinned. Consumers (e.g. @rp/events writer)
 * accept `tx: Transaction` to thread atomicity across packages.
 */
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];
