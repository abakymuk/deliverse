import { z } from 'zod';

/**
 * ModifierSnapshot — immutable per-line modifier record.
 *
 * Stored as jsonb on `cart_items.modifiers_json` and `order_line_items.modifiers_snapshot_json`.
 * Snapshot semantics: priceDeltaCents + name captured at add-to-cart time, never recomputed.
 * modifierGroupId + modifierId are soft pointers (no FK) — they survive hard-delete of the
 * underlying catalog row when X3 (catalog spine) lands.
 *
 * Key casing: camelCase — matches every other event-payload field and Drizzle's TS-side
 * naming convention. When X3 lands, mapping from snake_case catalog columns to this shape
 * happens at the read boundary (e.g., `{ modifierGroupId: row.modifier_group_id }`).
 * Changing this after consumers exist would be a breaking payload change (event_version bump).
 */
export const modifierSnapshotSchema = z.object({
  modifierGroupId: z.string().uuid(),
  modifierId: z.string().uuid(),
  name: z.string().min(1).max(200),
  priceDeltaCents: z.number().int(), // can be negative (discount modifier)
});

export const modifierSnapshotsSchema = z.array(modifierSnapshotSchema);

export type ModifierSnapshot = z.infer<typeof modifierSnapshotSchema>;
