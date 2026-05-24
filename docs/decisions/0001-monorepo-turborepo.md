# 0001 — Monorepo with Turborepo

**Date:** 2026-05-23
**Status:** Accepted

## Context

We have two deployable apps (platform and storefront) that share schema, auth utilities, and UI components. Three options for code organization.

## Decision

Use Turborepo + pnpm workspaces.

## Alternatives Considered

- **Separate repos with npm-published packages** — rejected: heavyweight for solo dev, slow iteration, version mismatch hell
- **Nx monorepo** — rejected: more complex than we need, opinionated about everything
- **Plain pnpm workspaces (no Turborepo)** — rejected: lacks build caching and pipeline definitions for CI
- **Turborepo + pnpm** — selected: minimal config, well-supported, fast incremental builds, Vercel-native

## Consequences

### Positive
- One `pnpm install`, all packages linked
- Build pipeline cached and parallelized
- Shared types compile-checked across apps
- Vercel deploys are trivial

### Negative
- Slightly steeper learning curve than single-repo
- CI needs to be aware of affected packages

### Neutral
- Standard pattern for modern TS monorepos
