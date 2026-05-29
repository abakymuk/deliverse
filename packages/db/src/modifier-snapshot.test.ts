/**
 * Pure unit tests for the ModifierSnapshot Zod schema — the typed shape
 * pinned for cart_items.modifiers_json and order_intent_items.modifiers_snapshot_json.
 *
 * Mirrors the validation-surface style of @rp/events writer.test.ts.
 *
 * Zod 4's UUID format is strict (v1–v8 + nil/max only) so test fixtures
 * must be real v4 UUIDs — crypto.randomUUID() is the cheapest way to get them.
 *
 * Note on extra keys: the schema uses Zod's default `.strip()` behavior, so
 * unknown keys are silently dropped, NOT rejected. No "rejects extra keys"
 * assertion lives here by design.
 */

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  type ModifierSnapshot,
  modifierSnapshotSchema,
  modifierSnapshotsSchema,
} from './modifier-snapshot';

function modifierFixture(
  overrides: Partial<ModifierSnapshot> = {},
): ModifierSnapshot {
  return {
    modifierGroupId: randomUUID(),
    modifierId: randomUUID(),
    name: 'Extra cheese',
    priceDeltaCents: 150,
    ...overrides,
  };
}

describe('modifierSnapshotSchema', () => {
  it('accepts a well-formed modifier', () => {
    expect(() => modifierSnapshotSchema.parse(modifierFixture())).not.toThrow();
  });

  it('accepts a negative priceDeltaCents (discount modifier)', () => {
    expect(() =>
      modifierSnapshotSchema.parse(modifierFixture({ priceDeltaCents: -100 })),
    ).not.toThrow();
  });

  it('rejects a malformed modifierGroupId', () => {
    expect(() =>
      modifierSnapshotSchema.parse(
        modifierFixture({ modifierGroupId: 'not-a-uuid' }),
      ),
    ).toThrow();
  });

  it('rejects a missing name', () => {
    const { name, ...rest } = modifierFixture();
    void name;
    expect(() => modifierSnapshotSchema.parse(rest)).toThrow();
  });

  it('rejects a zero-length name', () => {
    expect(() =>
      modifierSnapshotSchema.parse(modifierFixture({ name: '' })),
    ).toThrow();
  });

  it('rejects a non-integer priceDeltaCents', () => {
    expect(() =>
      modifierSnapshotSchema.parse(modifierFixture({ priceDeltaCents: 1.5 })),
    ).toThrow();
  });
});

describe('modifierSnapshotsSchema', () => {
  it('accepts an empty array', () => {
    expect(() => modifierSnapshotsSchema.parse([])).not.toThrow();
  });

  it('accepts a multi-modifier array', () => {
    const modifiers = [
      modifierFixture({ name: 'Extra cheese' }),
      modifierFixture({ name: 'No onions', priceDeltaCents: 0 }),
      modifierFixture({ name: 'Loyalty discount', priceDeltaCents: -200 }),
    ];
    expect(() => modifierSnapshotsSchema.parse(modifiers)).not.toThrow();
  });

  it('rejects an array with a malformed entry', () => {
    const modifiers = [modifierFixture(), { ...modifierFixture(), name: '' }];
    expect(() => modifierSnapshotsSchema.parse(modifiers)).toThrow();
  });

  it('round-trips through JSON stringify/parse', () => {
    const modifiers = modifierSnapshotsSchema.parse([
      modifierFixture(),
      modifierFixture({ name: 'No onions', priceDeltaCents: 0 }),
    ]);
    const roundTripped = modifierSnapshotsSchema.parse(
      JSON.parse(JSON.stringify(modifiers)),
    );
    expect(roundTripped).toEqual(modifiers);
  });
});
