# Development Workflow

> Plan → Build → Sync. The compound interest of solo development with AI.

---

## The Cycle

```
┌──────────┐      ┌──────────┐      ┌──────────┐
│   PLAN   │ ───▶ │  BUILD   │ ───▶ │   SYNC   │
└──────────┘      └──────────┘      └──────────┘
     ▲                                    │
     └────────────────────────────────────┘
```

Each cycle = one vertical slice = one mergeable change.

---

## Phase 1: PLAN

**Goal:** produce a spec before any code. One page max.

### Inputs
- User intent (verbal or text)
- Existing code, docs, AGENTS.md

### Outputs
- `docs/specs/<feature-name>.md`
- Acceptance criteria (3–7 testable)
- Non-goals (what we explicitly skip)
- Files that will change

### Process

1. **Open spec template:** `cp docs/specs/_template.md docs/specs/<feature>.md`
2. **Fill in the easy parts:** problem, users, acceptance criteria
3. **Identify unknowns:** mark them as **open questions** at top
4. **Run the questions through the user** before going to schema/code
5. **Lock the spec** when all open questions are resolved
6. **Commit the spec** separately from code

### Anti-patterns

- ❌ "Spec is in my head, I'll write it later" — you won't
- ❌ Spec longer than 1 page — you're hiding indecision
- ❌ Vague acceptance criteria — un-testable = un-completable
- ❌ Skipping non-goals — invites scope creep

---

## Phase 2: BUILD

**Goal:** ship the thinnest end-to-end vertical slice.

### Order of operations

1. **Schema** (if needed) — Drizzle changes, migration generated
2. **Server logic** — server action or API route, fully typed
3. **UI** — page + components, built on shadcn
4. **Test** — at least one integration test of the happy path
5. **Manual smoke** — actually click through on dev URL

### Co-location

```
src/features/<feature-name>/
├── components/
├── actions.ts
├── queries.ts
├── types.ts
└── README.md       (optional — link to spec)
```

No "all components in /components, all actions in /actions". Co-locate.

### Constraints for Claude Code sessions

- One session = one task. When session blurs, kill it and start fresh.
- Always start with: "Read AGENTS.md, read docs/specs/<feature>.md, read reference files X, Y. Propose a plan first."
- Reject "let me also..." additions. They go in next slice.

### Anti-patterns

- ❌ "I'll build the backend first, frontend later" — horizontal slicing
- ❌ Premature abstraction — write twice before extracting
- ❌ Adding new dependencies without ADR
- ❌ "Generic solution for future flexibility" — YAGNI

---

## Phase 3: SYNC

**Goal:** consolidate, document, ensure next session has good context.

### Checklist

- [ ] All tests pass (`pnpm test && pnpm test:e2e`)
- [ ] TypeScript clean (`pnpm typecheck`)
- [ ] Biome clean (`pnpm check`)
- [ ] AGENTS.md updated if conventions changed
- [ ] ADR added if architecturally significant
- [ ] Stale comments removed
- [ ] Spec marked ✅ Complete
- [ ] Manual smoke test on dev URL
- [ ] Commit message references spec

### What "architecturally significant" means

Anything where 6-months-from-now-you would ask "why did we do this?".
Examples:
- New dependency added
- Auth/security boundary changed
- Performance trade-off taken
- Convention changed

If yes → `docs/decisions/NNNN-short-name.md`.

---

## Session Lifecycle

### Session start (30 seconds, always)

```
"Read /AGENTS.md. Read /docs/specs/<feature>.md. Look at <relevant existing files>.
Propose a plan before any code."
```

### Mid-session (when blurring)

If AI starts contradicting itself, adding unrelated suggestions, or you feel lost:
**kill the session.** Start a new one with the latest state.

Stop loss > sunk cost.

### Session end

Before closing:
- Have I committed?
- Is the spec status updated?
- Is there a TODO list in `docs/specs/<feature>.md` for next time?
- Does AGENTS.md need an update?

---

## When to use Claude Code vs Cursor vs other

This is personal, but framework:

- **Claude Code:** larger refactors, multi-file features, "agent-driven" work where you want the AI to drive the keyboard
- **Cursor:** focused editing, inline completions, when you're driving and want assistance
- **Plain prompt (claude.ai):** spec writing, architectural thinking, decision-making

These complement, not compete. Use the right tool for the phase.

---

## Failure modes (and recovery)

| Symptom | Cause | Fix |
|---|---|---|
| AI writes wrong code repeatedly | Stale AGENTS.md | Update AGENTS.md, restart session |
| AI invents APIs | No reference files in context | Provide 2-3 reference files explicitly |
| Code works but you don't understand it | Skipped review | Re-read every line; ask AI to explain |
| Feature drifted from spec | No mid-build check-in | Pause, re-read spec, course-correct |
| Test suite slow / flaky | Accumulated cruft | Spend a session on cleanup, not features |
| Stack feels "fancy" | Premature optimization | Roll back to boring tech |
