/**
 * Pure unit tests for the writer's derivation logic — Zod validation,
 * aggregate type/id derivation, idempotency-key derivation.
 *
 * These tests don't exercise the DB write path. Transactional atomicity
 * (cart insert + event row commit-or-rollback together) is covered by
 * integration tests in tests/outbox-transactional.test.ts (DB-required;
 * skipped if DATABASE_URL is unset).
 */

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { domainEvent, type DomainEvent } from './schema';

// Re-exported test-only helpers: aggregate + idempotencyKey are private to
// writer.ts. We test them through their observable effects by parsing
// known-shaped events with domainEvent.parse and checking the writer's
// behavior via the integration tests. Here we instead test the schema's
// validation surface end-to-end since the writer's first action is
// domainEvent.parse(event).
//
// Zod 4's UUID format is strict (v1–v8 + nil/max only) so test fixtures
// must be real v4 UUIDs — crypto.randomUUID() is the cheapest way to get them.

const TENANT_ID = randomUUID();
const STOREFRONT_ID = randomUUID();
const USER_ID = randomUUID();
const SESSION_ID = randomUUID();
const CART_ID = randomUUID();
const CART_ITEM_ID = randomUUID();
const MENU_ITEM_ID = randomUUID();
const BRAND_ID = randomUUID();
const LOCATION_ID = randomUUID();
const ORDER_ID = randomUUID();

function baseFields() {
  return {
    tenantId: TENANT_ID,
    occurredAt: new Date().toISOString(),
    actorType: 'tenant_end_user' as const,
    actorId: USER_ID,
  };
}

describe('domainEvent — Zod validation', () => {
  describe('guest.signed_up', () => {
    it('accepts a well-formed payload', () => {
      const event: DomainEvent = {
        name: 'guest.signed_up',
        data: {
          ...baseFields(),
          userId: USER_ID,
          email: 'alice@example.com',
          method: 'otp',
          storefrontId: STOREFRONT_ID,
          brandId: BRAND_ID,
        },
      };
      expect(() => domainEvent.parse(event)).not.toThrow();
    });

    it('accepts method=unknown (v1 default from adapter)', () => {
      const event = {
        name: 'guest.signed_up' as const,
        data: {
          ...baseFields(),
          userId: USER_ID,
          email: 'alice@example.com',
          method: 'unknown' as const,
          storefrontId: STOREFRONT_ID,
          brandId: null,
        },
      };
      expect(() => domainEvent.parse(event)).not.toThrow();
    });

    it('rejects an invalid method', () => {
      const event = {
        name: 'guest.signed_up' as const,
        data: {
          ...baseFields(),
          userId: USER_ID,
          email: 'alice@example.com',
          method: 'sms_otp' as 'otp', // not in enum — type-narrow to bypass TS
          storefrontId: STOREFRONT_ID,
          brandId: null,
        },
      };
      expect(() => domainEvent.parse(event)).toThrow();
    });

    it('rejects a non-uuid actorId', () => {
      const event = {
        name: 'guest.signed_up' as const,
        data: {
          ...baseFields(),
          actorId: 'not-a-uuid',
          userId: USER_ID,
          email: 'alice@example.com',
          method: 'otp' as const,
          storefrontId: STOREFRONT_ID,
          brandId: null,
        },
      };
      expect(() => domainEvent.parse(event)).toThrow();
    });

    it('accepts null brandId (food-hall mode)', () => {
      const event: DomainEvent = {
        name: 'guest.signed_up',
        data: {
          ...baseFields(),
          userId: USER_ID,
          email: 'alice@example.com',
          method: 'oauth_google',
          storefrontId: STOREFRONT_ID,
          brandId: null,
        },
      };
      expect(() => domainEvent.parse(event)).not.toThrow();
    });
  });

  describe('guest.signed_in', () => {
    it('accepts a well-formed payload', () => {
      const event: DomainEvent = {
        name: 'guest.signed_in',
        data: {
          ...baseFields(),
          userId: USER_ID,
          sessionId: SESSION_ID,
          method: 'password',
          storefrontId: STOREFRONT_ID,
          brandId: BRAND_ID,
        },
      };
      expect(() => domainEvent.parse(event)).not.toThrow();
    });

    it('rejects missing sessionId', () => {
      const event = {
        name: 'guest.signed_in',
        data: {
          ...baseFields(),
          userId: USER_ID,
          method: 'otp',
          storefrontId: STOREFRONT_ID,
          brandId: null,
        },
      };
      expect(() => domainEvent.parse(event)).toThrow();
    });
  });

  describe('cart.item_added', () => {
    it('accepts a well-formed payload', () => {
      const event: DomainEvent = {
        name: 'cart.item_added',
        data: {
          ...baseFields(),
          cartId: CART_ID,
          cartItemId: CART_ITEM_ID,
          brandId: BRAND_ID,
          menuItemId: MENU_ITEM_ID,
          quantity: 2,
          unitPriceCents: 1299,
          locationId: LOCATION_ID,
        },
      };
      expect(() => domainEvent.parse(event)).not.toThrow();
    });

    it('rejects non-positive quantity', () => {
      const event = {
        name: 'cart.item_added',
        data: {
          ...baseFields(),
          cartId: CART_ID,
          cartItemId: CART_ITEM_ID,
          brandId: BRAND_ID,
          menuItemId: MENU_ITEM_ID,
          quantity: 0,
          unitPriceCents: 1299,
          locationId: LOCATION_ID,
        },
      };
      expect(() => domainEvent.parse(event)).toThrow();
    });

    it('rejects negative unitPriceCents', () => {
      const event = {
        name: 'cart.item_added',
        data: {
          ...baseFields(),
          cartId: CART_ID,
          cartItemId: CART_ITEM_ID,
          brandId: BRAND_ID,
          menuItemId: MENU_ITEM_ID,
          quantity: 1,
          unitPriceCents: -100,
          locationId: LOCATION_ID,
        },
      };
      expect(() => domainEvent.parse(event)).toThrow();
    });
  });

  describe('order_intent.placed', () => {
    it('accepts a well-formed multi-brand payload', () => {
      const event: DomainEvent = {
        name: 'order_intent.placed',
        data: {
          ...baseFields(),
          orderIntentId: ORDER_ID,
          cartId: CART_ID,
          locationId: LOCATION_ID,
          totalCents: 4500,
          subtotalCents: 4500,
          brandIds: [BRAND_ID, randomUUID()],
          lineItemCount: 3,
        },
      };
      expect(() => domainEvent.parse(event)).not.toThrow();
    });

    it('accepts empty brandIds (unusual but not invalid at v1)', () => {
      // brandIds is an array; v1 doesn't enforce non-empty. Consumer logic
      // decides what to do if empty.
      const event: DomainEvent = {
        name: 'order_intent.placed',
        data: {
          ...baseFields(),
          orderIntentId: ORDER_ID,
          cartId: null,
          locationId: LOCATION_ID,
          totalCents: 0,
          subtotalCents: 0,
          brandIds: [],
          lineItemCount: 1,
        },
      };
      expect(() => domainEvent.parse(event)).not.toThrow();
    });

    it('rejects a missing orderIntentId', () => {
      // fulfillmentType is intentionally NOT on the intent event (DEL-32):
      // fulfillment is per-brand on order_fulfillments. Guard a required field.
      const event = {
        name: 'order_intent.placed',
        data: {
          ...baseFields(),
          cartId: CART_ID,
          locationId: LOCATION_ID,
          totalCents: 1299,
          subtotalCents: 1299,
          brandIds: [BRAND_ID],
          lineItemCount: 1,
        },
      };
      expect(() => domainEvent.parse(event)).toThrow();
    });
  });

  describe('order_intent.cancelled (stub)', () => {
    it('accepts a well-formed payload with reason', () => {
      const event: DomainEvent = {
        name: 'order_intent.cancelled',
        data: {
          ...baseFields(),
          orderIntentId: ORDER_ID,
          reason: 'guest requested',
        },
      };
      expect(() => domainEvent.parse(event)).not.toThrow();
    });

    it('accepts null reason', () => {
      const event: DomainEvent = {
        name: 'order_intent.cancelled',
        data: {
          ...baseFields(),
          orderIntentId: ORDER_ID,
          reason: null,
        },
      };
      expect(() => domainEvent.parse(event)).not.toThrow();
    });
  });

  describe('actorType', () => {
    it('accepts system actor with null actorId', () => {
      const event: DomainEvent = {
        name: 'order_intent.cancelled',
        data: {
          tenantId: TENANT_ID,
          occurredAt: new Date().toISOString(),
          actorType: 'system',
          actorId: null,
          orderIntentId: ORDER_ID,
          reason: 'auto-cancelled after timeout',
        },
      };
      expect(() => domainEvent.parse(event)).not.toThrow();
    });

    it('rejects unknown actorType', () => {
      const event = {
        name: 'order_intent.cancelled',
        data: {
          tenantId: TENANT_ID,
          occurredAt: new Date().toISOString(),
          actorType: 'admin', // not in enum
          actorId: USER_ID,
          orderIntentId: ORDER_ID,
          reason: null,
        },
      };
      expect(() => domainEvent.parse(event)).toThrow();
    });
  });

  describe('_meta (consumer parse path)', () => {
    it('accepts payload with populated _meta (dispatcher-published shape)', () => {
      const outboxId = randomUUID();
      const event: DomainEvent = {
        name: 'cart.item_added',
        data: {
          ...baseFields(),
          cartId: CART_ID,
          cartItemId: CART_ITEM_ID,
          brandId: BRAND_ID,
          menuItemId: MENU_ITEM_ID,
          quantity: 1,
          unitPriceCents: 999,
          locationId: LOCATION_ID,
          _meta: {
            outboxId,
            eventVersion: 1,
            occurredAt: new Date().toISOString(),
            tenantId: TENANT_ID,
            actorType: 'tenant_end_user',
            actorId: USER_ID,
            idempotencyKey: null,
            correlationId: null,
            causationId: null,
          },
        },
      };
      // The point: domainEvent.parse does NOT strip _meta. Consumers can
      // read event.data._meta.idempotencyKey for downstream dedup.
      const parsed = domainEvent.parse(event);
      expect(parsed.data._meta?.outboxId).toBe(outboxId);
    });

    it('accepts payload without _meta (writer-path shape)', () => {
      const event: DomainEvent = {
        name: 'cart.item_added',
        data: {
          ...baseFields(),
          cartId: CART_ID,
          cartItemId: CART_ITEM_ID,
          brandId: BRAND_ID,
          menuItemId: MENU_ITEM_ID,
          quantity: 1,
          unitPriceCents: 999,
          locationId: LOCATION_ID,
        },
      };
      const parsed = domainEvent.parse(event);
      expect(parsed.data._meta).toBeUndefined();
    });
  });
});
