# <Feature Name> — Spec v1

**Created:** YYYY-MM-DD
**Status:** Draft | In Progress | Complete
**Owner:** <name>

---

## Problem

What hurts? Whose problem is this? In one paragraph, in their words.

## Users

Who exactly is this for? Be specific.
- Population A: ...
- Population B: ...

## Acceptance Criteria

Testable. 3-7 maximum. Each must be verifiable.
1. ...
2. ...
3. ...

## Non-Goals

What we are explicitly NOT doing in this version.
- ❌ ...
- ❌ ...

## Data Model Changes

Tables added, fields added, indexes added. Brief.

```
new table: feature_x
  - id, ...
  - tenant_id (FK)
```

## API Surface

Server actions / endpoints / events emitted.

```
- action createFeatureX(input: ZodSchema) → Result<FeatureX>
- event "feature_x.created" — payload {...}
```

## UI Sketch

ASCII art or wireframe link. Where does this live in navigation?

```
/feature-x
  └── list view
       └── detail page
```

## Edge Cases

Things that break on boundaries:
1. What if user has no tenant?
2. What if the tenant is in pending_deletion?
3. What if two users race the same operation?

## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| ... | L/M/H | L/M/H | ... |

## Open Questions

Things YOU don't know yet. Resolve before locking spec.
- ?

## Decisions Log

| Date | Decision | Reasoning |
|---|---|---|
| YYYY-MM-DD | ... | ... |

---

## Files that will change

- `packages/db/src/schema.ts` — add table X
- `apps/platform/src/features/feature-x/` — new feature folder
- ...
