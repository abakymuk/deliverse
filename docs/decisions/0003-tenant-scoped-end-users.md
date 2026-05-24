# 0003 — Tenant-scoped end users (not brand-scoped)

**Date:** 2026-05-23
**Status:** Accepted

## Context

End users (restaurant guests) need identity. With multi-brand tenants (one tenant operates multiple brands, e.g., dark kitchens), question: does a guest have one account per brand, or one account per tenant?

## Decision

Tenant-scoped: `UNIQUE(tenant_id, email)`. One account works across all brands of one tenant. Same email at different tenants = different accounts.

## Alternatives Considered

- **Brand-scoped:** John at Pizza Express ≠ John at Burger Heaven even if same tenant — rejected: tenant operators want unified customer base across their brands (loyalty programs, marketing, customer LTV)
- **Globally-scoped:** John at any restaurant = same account — rejected: violates tenant data isolation, breaks "tenant owns their customers" value prop
- **Tenant-scoped (selected):** unified within tenant, separate across tenants

## Consequences

### Positive
- Tenant-wide loyalty programs natural
- Cross-brand customer LTV analytics available
- Matches multi-unit chain operator expectations
- Aligns with Incentivio / Owner.com pattern

### Negative
- Cross-brand recognition UX must disclose ("Burger Heaven is part of {Tenant}'s family")
- GDPR / CCPA requires explicit disclosure
- Brand sale (out of scope v1) is complex when customers transfer

### Neutral
- Sessions store both `tenant_end_user_id` and `current_brand_id`
- OTP rate limiting is per (tenant, email)
