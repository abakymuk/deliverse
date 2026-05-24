# Skill: Feature Scaffold

> Creating a new feature folder consistently.

## When to use

Starting any new feature in `apps/platform` or `apps/storefront`.

## Folder convention

```
apps/<app>/src/features/<feature-name>/
├── components/
│   └── <feature-name>-form.tsx
├── actions.ts          ← Server actions
├── queries.ts          ← Drizzle queries (server-only)
├── types.ts            ← Zod schemas + TS types
├── schema.ts           ← If feature adds DB tables (rare; usually in packages/db)
└── README.md           ← Link to spec, brief overview
```

## Process

1. Read `docs/specs/<feature-name>.md` (must exist)
2. Create feature folder: `mkdir -p apps/<app>/src/features/<feature-name>/components`
3. Create `types.ts` first — defines the data shape
4. Create `queries.ts` — read operations
5. Create `actions.ts` — write operations (server actions)
6. Create page or component that consumes the above
7. Create `README.md` linking to spec
8. Write at least one integration test

## Example: `types.ts`

```typescript
import { z } from 'zod';

export const CreateFeatureXInput = z.object({
  name: z.string().min(1).max(100),
  tenantId: z.string().uuid(),
});

export type CreateFeatureXInput = z.infer<typeof CreateFeatureXInput>;

export type FeatureX = {
  id: string;
  name: string;
  tenantId: string;
  createdAt: Date;
};
```

## Example: `actions.ts`

```typescript
'use server';

import { revalidatePath } from 'next/cache';
import { auth } from '@/lib/auth';
import { headers } from 'next/headers';
import { db, featureX } from '@rp/db';
import { CreateFeatureXInput } from './types';

export async function createFeatureX(input: unknown) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) throw new Error('Unauthorized');

  const parsed = CreateFeatureXInput.parse(input);

  const [row] = await db.insert(featureX).values({
    ...parsed,
    createdBy: session.user.id,
  }).returning();

  revalidatePath('/features');
  return row;
}
```

## Anti-patterns

- ❌ Putting actions in `app/api/*` — use server actions
- ❌ Splitting feature across components/, actions/, hooks/ at app root — co-locate
- ❌ Missing zod validation at boundaries — runtime safety matters
- ❌ Importing client code from server (look at "use client" boundaries)
