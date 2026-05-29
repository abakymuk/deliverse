import { describe, expect, it } from 'vitest';
import { actorTypeEnum } from '@rp/db/schema';
import { actorType } from '../src/schema';

// DEL-33 / X2: the pg `actor_type` enum (structured columns: order_intents,
// order_modifications) and the @rp/events Zod `actorType` (event payloads)
// MUST stay identical — same members, in the same order, since a pgEnum's
// declaration order is its sort order. This test is the only mechanism keeping
// the two canonical lists from silently drifting.
describe('actor_type parity (pg enum ↔ @rp/events Zod enum)', () => {
  it('declares the same members in the same order', () => {
    expect([...actorTypeEnum.enumValues]).toEqual([...actorType.options]);
  });
});
