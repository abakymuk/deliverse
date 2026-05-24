# Skill: Self Code Review

> Before considering work "done", check this list.

## Pre-commit checklist

### Correctness
- [ ] All acceptance criteria from spec are met
- [ ] Manual smoke test passed on dev URL
- [ ] At least one integration test for the happy path
- [ ] Edge cases from spec are handled (not just considered)

### Security
- [ ] No secrets in code or commits
- [ ] All user input validated (zod) at boundaries
- [ ] DB queries are tenant-scoped where applicable
- [ ] No `dangerouslySetInnerHTML` without sanitization
- [ ] Auth check is present on protected actions

### TypeScript
- [ ] No `any`. Use `unknown` + narrowing.
- [ ] No `// @ts-ignore` or `// @ts-expect-error` without explanation
- [ ] No `!` non-null assertions on user-controlled data
- [ ] Imports use `type` keyword where applicable

### Performance
- [ ] No N+1 queries (use joins or batched queries)
- [ ] Server components used by default
- [ ] Client components only where needed
- [ ] Images use Next.js `<Image>`

### Maintainability
- [ ] Comments explain WHY, not WHAT
- [ ] No commented-out code
- [ ] No `console.log` in production code
- [ ] Variable/function names are self-documenting
- [ ] File length reasonable (< 300 lines guideline)

### Documentation
- [ ] AGENTS.md updated if conventions changed
- [ ] Spec marked as Complete
- [ ] ADR added if architecturally significant
- [ ] Public API has JSDoc

## How to do it

Don't just skim. For each file changed:
1. Read every line
2. Ask: "would I let a junior commit this?"
3. Ask: "will I understand this in 6 months?"
4. Run through this checklist explicitly

The exercise itself is the value. The checklist is a forcing function.
