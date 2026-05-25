# Project Tree

```
deliverse/
├── AGENTS.md                       ← Constitution. Read first.
├── README.md                       ← Getting started
├── .env.example                    ← Env vars to copy
├── .nvmrc                          ← Node version
├── package.json                    ← Root scripts
├── pnpm-workspace.yaml             ← Workspace definition
├── turbo.json                      ← Build pipeline
├── biome.json                      ← Linter/formatter
├── tsconfig.json                   ← Base TS config
│
├── apps/
│   ├── platform/                   ← admin.deliverse.app
│   │   ├── AGENTS.md
│   │   ├── package.json
│   │   ├── next.config.ts
│   │   ├── tsconfig.json
│   │   ├── postcss.config.mjs
│   │   ├── playwright.config.ts
│   │   ├── src/
│   │   │   ├── app/
│   │   │   │   ├── (auth)/         ← Public auth routes
│   │   │   │   │   ├── login/
│   │   │   │   │   ├── signup/
│   │   │   │   │   ├── forgot-password/
│   │   │   │   │   ├── reset-password/
│   │   │   │   │   ├── verify-email/
│   │   │   │   │   └── layout.tsx
│   │   │   │   ├── (dashboard)/    ← Protected routes
│   │   │   │   │   ├── layout.tsx
│   │   │   │   │   ├── page.tsx
│   │   │   │   │   └── tenants/
│   │   │   │   ├── api/auth/[...all]/route.ts
│   │   │   │   ├── globals.css
│   │   │   │   ├── layout.tsx
│   │   │   │   └── page.tsx
│   │   │   ├── components/
│   │   │   │   ├── auth/
│   │   │   │   │   └── login-form.tsx
│   │   │   │   └── layout/
│   │   │   ├── lib/
│   │   │   │   ├── auth.ts
│   │   │   │   └── auth-client.ts
│   │   │   └── middleware.ts
│   │   └── tests/e2e/auth.spec.ts
│   │
│   └── storefront/                 ← {brand}.deliverse.app
│       ├── AGENTS.md
│       ├── package.json
│       ├── next.config.ts
│       ├── tsconfig.json
│       ├── playwright.config.ts
│       ├── src/
│       │   ├── app/
│       │   │   ├── (auth)/
│       │   │   │   ├── login/
│       │   │   │   ├── signup/
│       │   │   │   ├── verify-otp/
│       │   │   │   └── layout.tsx
│       │   │   ├── (shop)/
│       │   │   ├── api/auth/[...all]/route.ts
│       │   │   ├── globals.css
│       │   │   ├── layout.tsx
│       │   │   └── page.tsx
│       │   ├── components/
│       │   │   ├── auth/
│       │   │   │   ├── login-form.tsx
│       │   │   │   └── verify-otp-form.tsx
│       │   │   ├── brand/
│       │   │   └── layout/
│       │   ├── lib/
│       │   │   ├── auth.ts
│       │   │   ├── auth-client.ts
│       │   │   └── tenant-resolution.ts  ← THE key piece
│       │   └── middleware.ts
│       └── tests/e2e/auth.spec.ts
│
├── packages/
│   ├── db/                         ← Drizzle schema + client
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   ├── drizzle.config.ts
│   │   ├── src/
│   │   │   ├── schema.ts           ← All tables defined here
│   │   │   ├── client.ts
│   │   │   ├── index.ts
│   │   │   ├── migrate.ts
│   │   │   └── seed.ts
│   │   └── migrations/
│   │
│   ├── ui/                         ← shadcn/ui components
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   ├── components.json
│   │   └── src/
│   │       ├── components/
│   │       ├── lib/utils.ts
│   │       └── styles/globals.css
│   │
│   ├── auth-core/                  ← Better-Auth configs
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── src/
│   │       ├── platform.ts         ← BA instance #1
│   │       ├── storefront.ts       ← BA instance #2
│   │       └── index.ts
│   │
│   └── typescript-config/          ← Shared tsconfigs
│       ├── package.json
│       ├── base.json
│       ├── nextjs.json
│       └── library.json
│
├── docs/
│   ├── architecture.md             ← High-level overview
│   ├── auth-spec.md                ← Detailed auth spec v3
│   ├── development-workflow.md     ← Plan → Build → Sync
│   ├── project-tree.md             ← This file
│   ├── decisions/                  ← ADRs
│   │   ├── README.md
│   │   ├── _template.md
│   │   ├── 0001-monorepo-turborepo.md
│   │   ├── 0002-better-auth-vs-clerk.md
│   │   ├── 0003-tenant-scoped-end-users.md
│   │   └── 0004-two-nextjs-apps.md
│   ├── specs/                      ← Per-feature specs
│   │   └── _template.md
│   └── skills/                     ← Reusable Claude Code skills
│       ├── README.md
│       ├── premortem.md
│       ├── feature-scaffold.md
│       └── code-review-self.md
│
├── .github/workflows/ci.yml
└── .vscode/
    ├── settings.json
    └── extensions.json
```

## File counts (approx)

- Total files: ~50
- Lines of code (incl docs): ~5000
- Docs / code ratio: ~30% — high by design (compound interest)
