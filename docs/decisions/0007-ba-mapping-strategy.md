# 0007 — Map Better-Auth fields to our schema, don't rename schema to BA defaults

**Date:** 2026-05-25
**Status:** Accepted
**Deciders:** Vlad

## Context

Better-Auth's Drizzle adapter (`better-auth@1.6.11`) requires explicit field mappings via the per-model `fields:` config and per-model `modelName:` overrides. There is no fallback to column-name lookup — a missing mapping fails at the type layer (TypeScript) or silently writes to the wrong column at runtime.

Our schema already uses domain-driven names: `platform_users` / `tenant_end_users` (not BA's default `user`), `platform_user_id` / `tenant_end_user_id` (not `user_id`), `email_verified_at` (now `email_verified` per [DEL-10](https://linear.app/oveglobal/issue/DEL-10)). We also run **two** BA instances over **one** database (platform + storefront) — both can't use BA's default table names (`user`, `session`, `account`, `verification`) because they would collide.

Question: should we rename our schema to match BA's defaults (one-time fight) or map BA to our schema (per-model `fields:` config, forever)?

## Decision

Map BA → schema. Our column and table names stay; BA is configured to point at them via `fields` and `modelName`.

**Crucial detail for the Drizzle adapter:** the `fields:` config values must be **Drizzle property keys** (camelCase, as declared in `schema.ts`), not SQL column names. The adapter (`@better-auth/drizzle-adapter@1.6.11`, `dist/index.mjs:89,120,170`) accesses columns as `schemaModel[field]`, and `schemaModel` is the Drizzle table object — its keys are the JS property names. Passing the SQL column name (e.g. `'platform_user_id'`) throws `BetterAuthError: The field "userId" does not exist in the schema for the model "account"`. Concretely:

| Layer | Example |
|---|---|
| SQL column | `platform_user_id` |
| Drizzle property (`platformAccounts.platformUserId`) | `platformUserId` |
| **BA mapping value** (`fields.userId: '…'`) | **`'platformUserId'`** |

[docs/specs/schema-v1-ba-compat.md §6](../specs/schema-v1-ba-compat.md#6-ba-field-audit) lists the mapping for every model in this form, ready to copy verbatim into DEL-11.

## Alternatives Considered

- **Rename schema → BA defaults** (`platform_users` → `platform_user` then map to `user` model, columns become `user_id`/`email_verified`/`name`/`image`).
  Rejected because:
  - Two BA instances cannot both claim `user`/`session`/`account`/`verification` table names. We'd still need `modelName` overrides, and at that point we have both renaming pain *and* mapping pain.
  - Self-documenting names lose: `tenant_end_user_id` in a query is unambiguous; `user_id` requires reading the surrounding `JOIN` to know which user space.
  - Tenant-scoped uniqueness on end users (`UNIQUE(tenant_id, email) WHERE deleted_at IS NULL`) deliberately diverges from BA's global `user.email UNIQUE`. The divergence is a feature; renaming hides it.
  - We'd still need `fields:` for the divergent fields (`emailVerified` semantics, soft-delete `deletedAt`, the storefront `additionalFields`).

- **Map BA → schema (chosen).**
  - BA's `fields:` config exists exactly for this. It's a one-line-per-column declaration, type-checked, colocated with the rest of the auth config.
  - Two instances coexist cleanly: platform maps `user → platform_users`, storefront maps `user → tenant_end_users`. Same DB, no collision.
  - Domain names survive. Queries stay readable.
  - BA upgrades = re-audit the `fields` map for added/renamed core fields, not a rename migration over our data.

## Consequences

### Positive

- Domain-driven naming preserved across schema, queries, and API surfaces.
- Two BA instances over one Postgres without table-name collision.
- BA version upgrades become a `fields:` diff, not a schema migration.
- The mapping table in [docs/specs/schema-v1-ba-compat.md §6](../specs/schema-v1-ba-compat.md#6-ba-field-audit) is the canonical reference for DEL-11 — implementation is mechanical translation, not design work.

### Negative

- Every BA model needs an explicit `fields:` entry in `packages/auth-core/*.ts`. A mismatched mapping (notably: SQL column name instead of Drizzle property name) throws a `BetterAuthError` from the adapter on the first request that touches the model — loud, but only at runtime.
  - **Mitigation:** the spec's audit table enumerates every required mapping in Drizzle-property form. DEL-11 must produce mappings for every 🅿️ row before merging.
  - **Mitigation:** end-to-end integration test (planned in DEL-1 follow-up) exercises signup → session → membership lookup on both instances. A missed mapping breaks the test.
- Future BA plugins (`admin`, `two-factor`, `passkey`) require re-running the same audit: read the plugin's `schema.*.fields`, add `fields:` entries before enabling. This becomes the standing checklist for any new BA plugin.
- Tenant-scoped email uniqueness on `tenant_end_users` is a constraint our schema enforces on writes, but BA's default email lookups are not tenant-aware. The storefront BA instance is unsafe to expose until DEL-3 (tenant resolution) + DEL-11 (wrapped adapter / custom endpoints) inject `tenant_id` into every lookup and create path.

### Neutral

- `metadata` on `tenants` is `jsonb` while BA core types it as `string`. ⚠️ Round-trip behavior through the adapter is not yet proven for `better-auth@1.6.11`. DEL-11 must exercise an org create/update with non-trivial metadata and verify read-back parity. Likely fine, but if broken: switch the column to `text` and let BA stringify, or wrap the adapter with a transform.
- `tenant_role` Postgres enum constrains `member.role` and `invitation.role` more strictly than BA's `string`. Custom roles (`owner`/`manager`/`staff`/`viewer`) are wired via `accessControl` in DEL-11.

## Migration impact

Greenfield. No data exists yet. The single existing `0000_strange_stephen_strange.sql` migration is deleted and regenerated to capture the v1 schema as one canonical file. No production data to ALTER, no rollback plan beyond `git revert` + regenerate.

## Future implications

- Standing rule for any new BA plugin: read `plugin.schema.<model>.fields` from `node_modules/.../better-auth/dist/plugins/<name>/...` *(not docs)*, add corresponding `fields:` mappings to the relevant `auth-core/*.ts` config, then enable.
- If we ever need a third BA instance (unlikely — would require a third user population), the pattern extends cleanly: new `modelName` set, new `fields:` map, same DB.
- Schema renames in the future (e.g., `platform_users` → `staff`) only touch our schema + the `fields:` config — BA core is untouched.

## References

- [DEL-10 issue](https://linear.app/oveglobal/issue/DEL-10/drizzle-schema-v1-better-auth-compatible-identity-schema)
- [docs/specs/schema-v1-ba-compat.md](../specs/schema-v1-ba-compat.md) — column-level diff and BA field audit (Drizzle-property-named)
- [docs/auth-spec.md](../auth-spec.md) §3 (user populations), §8 (data model), §12 (security posture)
- [0002-better-auth-vs-clerk.md](0002-better-auth-vs-clerk.md) — note already flags "BA model name vs table name mapping requires care"
- BA source: `node_modules/.../@better-auth/core/dist/db/get-tables.mjs` (core models)
- BA source: `node_modules/.../better-auth/dist/plugins/organization/organization.mjs` (org plugin + `activeOrganizationId` session augmentation)
- BA source: `node_modules/.../@better-auth/drizzle-adapter/dist/index.mjs:89,120,170` — `schemaModel[field]` access pattern proving `fields:` values must be Drizzle property keys
