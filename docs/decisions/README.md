# Architecture Decision Records (ADRs)

Each significant architectural decision gets its own file. Naming: `NNNN-short-name.md`.

## Why ADRs

- 6 months from now, "why did we do X?" has an answer
- New sessions don't re-litigate settled decisions
- AI sees ADRs and stops suggesting alternatives we already rejected

## When to write one

Yes:
- New dependency added
- Auth / security boundary changed
- Convention changed
- Significant trade-off taken

No:
- "I named a variable foo instead of bar"
- "I used Array.map instead of for-loop"

## Format

See `_template.md`.

## Index

- [0001 — Monorepo with Turborepo](./0001-monorepo-turborepo.md)
- [0002 — Better-Auth, not Clerk](./0002-better-auth-vs-clerk.md)
- [0003 — Tenant-scoped end users](./0003-tenant-scoped-end-users.md)
- [0004 — Two Next.js apps](./0004-two-nextjs-apps.md)
- [0005 — Doppler + Vercel for secrets and deployment](./0005-doppler-vercel.md)
- [0006 — Neon Postgres (serverless)](./0006-neon-postgres.md)
