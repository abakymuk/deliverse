# Linear Workflow

> **Read this before touching Linear.** Read `AGENTS.md` first, then `docs/development-workflow.md`, then this. It's the constitution for how we track work.

---

## What Linear is for

Linear is the **source of truth for "what we're working on"**. It is *not* the source of truth for "why" or "how" — those live in `docs/`. The split is enforced:

| Concern | Lives in |
|---|---|
| What we're doing right now | Linear (issue in `Todo` / `In Progress`) |
| What's next | Linear (issue in `Backlog`, ordered by priority + blockers) |
| Why we're doing it | `docs/auth-spec.md`, `docs/architecture.md`, ADRs |
| How we'll do it (this specific feature) | `docs/specs/<slug>.md` |
| Architecturally significant choices | `docs/decisions/NNNN-*.md` |

If you find yourself writing scope, acceptance criteria, or implementation details *inside Linear* beyond the issue body template below — stop. That belongs in a spec.

---

## Hierarchy

```
Team (deliverse)
 └── Project (Phase N — Title)
      └── Milestone (M0, M1, …)
           └── Issue (DEL-N)
                └── Spec (docs/specs/<slug>.md)
                ├── ADR (docs/decisions/NNNN-*.md, when applicable)
                └── PR (GitHub, linked via `links`)
```

**Never skip a level.** No orphan issues (must belong to a project + milestone). No project without at least one milestone. No feature issue without a spec.

---

## Project shape

- **Name format:** `Phase N — Title`. N is a monotonic integer; titles are noun phrases describing the outcome, not the activity. Good: "Phase 0 — Foundation". Bad: "Phase 0 — Setting things up".
- **Required fields:** icon, color, summary, full Markdown description, startDate, targetDate, lead, priority, at least one team.
- **Description sections:** Why now / Definition of Done / Scope / Non-goals / References. Same shape as `AGENTS.md`.
- **One Urgent project at a time.** Two Urgent projects = zero Urgent projects. If a second project becomes Urgent, the first one is done or wrong.
- **A project closes** when its Definition of Done holds *in production* and all milestones are complete. Soft-completing because "we got distracted" is forbidden — cancel the project explicitly instead.

---

## Milestone shape

- **Name format:** `M<n> — Outcome`. Outcome is a state of the world, not a deliverable. Good: "M0 — Local-dev unblock". Bad: "M0 — Seed script".
- **Cardinality:** 1–3 milestones per project in v1. More than 3 means the project is two projects.
- **Every milestone has a `targetDate`.** If you can't pick one, you don't understand the scope yet.
- **Milestones are not sprints.** They are checkpoints. A milestone is done when all its issues are done AND the outcome state can be demonstrated.

---

## Issue shape

### Required fields

- `team`, `project`, `milestone`, `assignee`, `state`, `labels`, `priority`, `title`.

### Required body sections, in order

1. **Why** — one paragraph. References auth-spec / ADR / prior issue when relevant.
2. **Acceptance criteria** — 3–7, ordered, testable, the kind a reviewer can check off.
3. **Files that will change** — concrete repo paths. Stale paths > no paths.
4. **Non-goals** — what we explicitly skip in this slice.
5. **Dependencies** — free-text, mirrored into `blockedBy` / `relatedTo` relations.

### Acceptance criterion #1 is *always* the spec

For every **feature** issue, AC#1 is verbatim:

> "Spec at `docs/specs/<slug>.md` is written, reviewed, and linked from this issue."

Bugs and chores can skip. Anything bigger than ~2 hours of work cannot.

### Title rules

- Imperative or descriptive noun phrase. Not a question, not a hedge.
- Good: "Seed script: admin + tenant + 2 brands + 2 locations + dark-kitchen link".
- Bad: "Look into seed data?" / "Maybe set up seeds".
- Mention the area (auth, db, ui, …) implicitly through labels, not in the title.

---

## Labels

### Workspace-level (do NOT recreate)

`Bug`, `Improvement`, `Feature` — reuse the existing IDs from the workspace.

### Team-scoped domain labels (deliverse)

`db`, `auth`, `ui`, `infra`, `e2e`, `docs`.

### Per-issue rule

Every issue carries `Feature` (or `Bug` / `Improvement`) **plus one to three domain labels**. Examples seen in Phase 0 + Phase 1: `Feature + db + infra`, `Feature + auth + db + docs`, `Feature + e2e + infra`.

### Anti-patterns

- ❌ `Feature` alone — gives no signal beyond "it's a feature".
- ❌ More than three domain labels — the issue is too broad; split it.
- ❌ Creating new domain labels casually — they accumulate and stop carrying signal. Add a new domain label only when at least 3 future issues will use it.

---

## Priorities

| Priority | When to use |
|---|---|
| 1 Urgent | At most one project + a handful of issues. "If this slips a week, the phase slips." |
| 2 High | Default for active phase. Most active-milestone issues land here. |
| 3 Medium | Important but not on the current milestone's critical path. |
| 4 Low | Backlog / parking lot. |
| 0 None | Forbidden. Pick one. |

**Inflation kills the signal.** If every issue is High, nothing is High.

---

## Dependencies

### Field semantics

- `blockedBy` — **hard** dependency. Cannot start until the blocker is `Done`. Linear shows this in the "Blocked" filter; the agent treats it as a do-not-pull signal.
- `relatedTo` — **soft**. Can proceed in parallel; a final smoke test or merge order may be required. Use this when an issue *could* be done first but doesn't have to be.
- `blocks` — **derived, do not set manually**. It's the inverse of `blockedBy` on the other issue. Linear keeps both sides in sync.

### MCP behavior — read this

The Linear MCP's `save_issue` treats `blockedBy`, `blocks`, `relatedTo` as **append-only** arrays. Passing `blockedBy: ["DEL-3"]` to an issue that already has `["DEL-1"]` results in `["DEL-1", "DEL-3"]`, not `["DEL-3"]`. To remove a relation, use `removeBlockedBy` / `removeBlocks` / `removeRelatedTo`.

### Never

- ❌ Manually set `blocks` — derive it from peers' `blockedBy`.
- ❌ Use `blockedBy` for "would be nice if X were done first" — that's `relatedTo`.
- ❌ Add `blockedBy` to circumvent priority — if it's higher priority, just raise the priority.

---

## State machine

```
Backlog → Todo → In Progress → In Review → Done
                              ↘
                                Canceled (with comment)
```

| State | Meaning |
|---|---|
| `Backlog` | Known but not pulled. Lives here until a developer commits to it. |
| `Todo` | Next up. **At most one issue in `Todo` at a time** (solo dev: one global). |
| `In Progress` | A session is actively coding this. Branch checked out. |
| `In Review` | PR open. Waiting for review / CI. |
| `Done` | Merged + smoke-tested on dev. Spec marked ✅. |
| `Canceled` | Explicit no-go. **Requires a comment explaining why** — never silently abandoned. |

### Transitions

- `Backlog → Todo` — manual, when ready to pull.
- `Todo → In Progress` — at session start, before writing any code.
- `In Progress → In Review` — when the PR opens.
- `In Review → Done` — after merge + manual dev-URL smoke.
- `Anything → Canceled` — always with a comment.

**No skipping `In Review`.** Even solo, a PR exists; the state reflects it.

---

## Spec + ADR rules

### Specs (`docs/specs/<slug>.md`)

- One per feature issue. AC#1 of that issue.
- Use `docs/specs/_template.md`.
- One page max. If it doesn't fit, the issue is too broad.
- Lives in the same branch as the implementation PR — spec lands first in the diff, code follows.

### ADRs (`docs/decisions/NNNN-<slug>.md`)

- Required for: new dependency, new package, auth/security boundary change, performance trade-off taken, convention change. (Mirrors `docs/development-workflow.md`.)
- Use `docs/decisions/_template.md`.
- **Never reserve ADR numbers in Linear.** Issue bodies use `<next-ADR>` or "next available ADR number". The implementing branch runs `ls docs/decisions/` and picks the next free integer at write time. Two parallel issues hard-coding `0007` and `0008` will collide.

---

## MCP discipline (when AI agents touch Linear)

Mandatory for any agent (or human-driven script) that mutates Linear via the MCP.

### 1. Discover before create

Every `create_*` / `save_*` without an `id` is preceded by a `list_*` to dedupe.

| Object | Dedupe key | Lookup |
|---|---|---|
| Issue label | exact `name` (case-sensitive), team scope falling back to workspace | `list_issue_labels({ team })`, then `list_issue_labels({})` if workspace label missing |
| Project | exact `name` AND team in `teams[]` | `list_projects({})` filtered for team UUID |
| Milestone | exact `name` within the given project | `list_milestones({ project })` |
| Issue | exact `title` AND same project AND same team | `list_issues({ team, project, query: title })` then post-filter |

### 2. Use IDs once captured, not strings

The MCP accepts both names and UUIDs in most fields. Once a `create_*` returns an ID, prefer the UUID. Strings are brittle (renames, typos, locale).

### 3. Capture every returned ID

Maintain a session-local map keyed by short code or name. Subsequent operations reference the map, not literals.

### 4. Relations are append-only

See "Dependencies" above. Pass full intended lists when in doubt, or use the `remove*` fields explicitly.

### 5. Don't reserve ADR numbers in issue bodies

See "ADRs" above. AI agents WILL pattern-match a number you write down and "respect" it later. Use the placeholder.

---

## Cadence

| Frequency | Activity |
|---|---|
| Per session start | Read AGENTS.md → current Linear `Todo` issue → linked spec → reference files. Then propose plan. |
| Per session end | Update Linear state, update spec status, commit if applicable. |
| Per PR | Update Linear to `In Review`; link PR via `links`; mention `Closes DEL-N` in the merge commit. |
| Weekly | Skim Backlog. Promote one issue to `Todo` when the current one lands. Update AGENTS.md "Current Focus" to mirror the active milestone. |
| Per phase | Review milestone progress. If drift > 1 week vs `targetDate`, either re-scope the milestone or re-spec the offending issue. |
| Per quarter | Read AGENTS.md, root docs, and `docs/decisions/` end to end. Prune stale issues, archive completed projects. |

---

## Never do

- ❌ Create an issue without `Why` + `Acceptance criteria` + `Files`. AI agents will pattern-match the void and invent specs.
- ❌ Hard-code ADR numbers in Linear bodies. Two issues will collide.
- ❌ Create more than one Urgent project at once.
- ❌ Skip the spec for a non-trivial feature (anything > 2h of work).
- ❌ Use `blockedBy` for soft dependencies — that's `relatedTo`.
- ❌ Manually edit `blocks` — derive it.
- ❌ Soft-delete an issue by clearing fields. Use `Canceled` with a comment.
- ❌ Pull from `Backlog` straight to `In Progress`. Always promote to `Todo` first, even if for 30 seconds.
- ❌ Have more than one issue in `Todo` simultaneously. The point of `Todo` is "this is the next thing".
- ❌ Treat Linear comments as design discussion. Comments are for status updates and merge notes. Design lives in the spec.
- ❌ Mix English and another language in titles. Body is fine; titles must be English for grep-ability.

---

## How to ask an AI agent to work in Linear

**Good prompt:**

> "Read `docs/linear-workflow.md` and `docs/specs/seed-data.md`. We're working on DEL-1. Move it to `In Progress`. Then propose a plan covering: schema queries, server actions, idempotent insert pattern, README diff. Don't write code yet."

**Bad prompt:**

> "Update Linear" / "Make some issues for next sprint" / "Set up the auth project."

The first one gives the agent a state to read from, a state to write to, and concrete constraints. The second forces guessing — which means hallucinated issue titles, missing AC#1, and silent ADR-number collisions.

---

## Maintainer

- Owner: Vlad
- Last review: 2026-05-25
- Next review: weekly during active development, after each project closes
