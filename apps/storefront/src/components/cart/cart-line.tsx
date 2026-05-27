'use client';

import { useTransition } from 'react';
import { Button } from '@rp/ui/components/button';
import {
  removeCartItemAction,
  updateCartItemQuantityAction,
} from '@/app/(shop)/cart/actions';

type CartLineProps = {
  cartItemId: string;
  name: string;
  brandName: string;
  unitPriceCents: number;
  quantity: number;
  currentPath: string;
};

/**
 * Single line inside the cart summary. Renders qty controls + remove
 * button; each mutation goes through a server action via FormData. Uses
 * `useTransition` so the buttons disable + show pending state during the
 * round trip without blocking other lines.
 *
 * DEL-25 PR 25b.
 */
export function CartLine({
  cartItemId,
  name,
  brandName,
  unitPriceCents,
  quantity,
  currentPath,
}: CartLineProps) {
  const [pending, startTransition] = useTransition();
  const lineTotal = ((unitPriceCents * quantity) / 100).toFixed(2);
  const unitPrice = (unitPriceCents / 100).toFixed(2);

  function submit(action: (formData: FormData) => Promise<void>, qty?: number) {
    startTransition(async () => {
      const formData = new FormData();
      formData.set('cartItemId', cartItemId);
      formData.set('currentPath', currentPath);
      if (qty !== undefined) formData.set('quantity', String(qty));
      await action(formData);
    });
  }

  return (
    <li className="flex items-start justify-between gap-4 border-b border-[var(--color-border)] py-3">
      <div className="min-w-0 flex-1">
        <p className="font-medium">{name}</p>
        <p className="text-sm text-[var(--color-muted-foreground)]">
          {brandName} · ${unitPrice}
        </p>
      </div>
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={pending || quantity <= 1}
          onClick={() => submit(updateCartItemQuantityAction, quantity - 1)}
          aria-label="Decrease quantity"
        >
          −
        </Button>
        <span
          className="w-6 text-center text-sm tabular-nums"
          aria-live="polite"
          aria-label={`Quantity ${quantity}`}
        >
          {quantity}
        </span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={pending}
          onClick={() => submit(updateCartItemQuantityAction, quantity + 1)}
          aria-label="Increase quantity"
        >
          +
        </Button>
      </div>
      <div className="flex flex-col items-end gap-1">
        <p className="font-semibold tabular-nums">${lineTotal}</p>
        <Button
          type="button"
          variant="link"
          size="sm"
          disabled={pending}
          onClick={() => submit(removeCartItemAction)}
        >
          Remove
        </Button>
      </div>
    </li>
  );
}
