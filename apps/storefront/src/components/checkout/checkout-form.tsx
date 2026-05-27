'use client';

import { useTransition } from 'react';
import { Button } from '@rp/ui/components/button';
import { placeOrderAction } from '@/app/(shop)/checkout/actions';

/**
 * Client component. Fulfillment-type picker (pickup / delivery) +
 * "Place order" button. Posts to `placeOrderAction` via FormData.
 * `useTransition` for pending state.
 *
 * Native radio inputs (no shadcn Radio primitive installed; the form
 * is simple enough that React Hook Form would be overkill — login-form
 * is the precedent for RHF, but this is one boolean choice).
 *
 * DEL-25 PR 25c.
 */
export function CheckoutForm() {
  const [pending, startTransition] = useTransition();
  return (
    <form
      action={(formData) => {
        startTransition(async () => {
          await placeOrderAction(formData);
        });
      }}
      className="space-y-6"
    >
      <fieldset className="space-y-3">
        <legend className="font-medium">Fulfillment</legend>
        <label className="flex items-center gap-3">
          <input
            type="radio"
            name="fulfillmentType"
            value="pickup"
            defaultChecked
            disabled={pending}
            className="h-4 w-4"
          />
          <span>Pickup</span>
        </label>
        <label className="flex items-center gap-3">
          <input
            type="radio"
            name="fulfillmentType"
            value="delivery"
            disabled={pending}
            className="h-4 w-4"
          />
          <span>Delivery</span>
        </label>
      </fieldset>
      <Button type="submit" disabled={pending}>
        {pending ? 'Placing order…' : 'Place order'}
      </Button>
    </form>
  );
}
