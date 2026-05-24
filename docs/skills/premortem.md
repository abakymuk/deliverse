# Skill: Premortem

> Before starting a major piece of work, imagine it failed. Work backwards.

## When to use

- Before any feature > 2 hours of work
- Before any architectural change
- Before any decision that's hard to reverse
- When you feel TOO confident about a plan

## Process

1. **Imagine the project is finished AND has failed.** Six months from now, it's a disaster.
2. **Write down why it failed.** Be specific.
3. **For each reason, ask: "Can I mitigate this NOW?"**
4. **Update spec, plan, or decision with mitigations.**

## Template

```markdown
## Premortem

### Imagining the failure

It's six months later. <Feature/decision> has failed. Symptoms:
- ...
- ...

### Top failure causes

1. <Cause 1>
   - **Likelihood:** L/M/H
   - **Mitigation:** ...

2. <Cause 2>
   - **Likelihood:** L/M/H
   - **Mitigation:** ...

### Updated plan

- [ ] Added mitigation X to spec
- [ ] Decision Y deferred to v2
- [ ] Test Z added to prevent regression
```

## Example failure causes to look for

- **Stack risk:** new dependency we don't really need
- **Scope risk:** we're trying to do 3 things at once
- **Coupling risk:** this touches too many other features
- **Stale data risk:** AI is working from outdated context
- **Process risk:** no test path = no confidence in deploys
- **People risk:** decision is in your head, not documented

## Anti-pattern

- Skipping premortem because "I'm confident this will work"
- Listing 15 risks but mitigating none
- Mitigations that are themselves vague ("be careful")
