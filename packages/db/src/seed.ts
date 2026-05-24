/**
 * Seed script — creates initial data for local development.
 *
 * Usage:
 *   pnpm db:seed
 *
 * Creates:
 *   - 1 platform admin user
 *   - 2 test tenants (with brands and locations)
 *   - Sample end users for testing
 *
 * IDEMPOTENT: safe to run multiple times. Uses ON CONFLICT.
 */

import { db } from './client';
// import { platformUsers, tenants, brands, locations } from './schema';

async function seed() {
  console.log('Seeding database...');

  // TODO: Implement after schema is in place
  // 1. Create admin platform_user
  // 2. Create 2 test tenants
  // 3. Create locations and brands
  // 4. Link them via location_brands

  console.log('Seed complete.');
}

seed()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Seed failed:', err);
    process.exit(1);
  });
