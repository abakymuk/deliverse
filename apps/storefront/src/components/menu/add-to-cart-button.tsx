'use client';

import { useTransition } from 'react';
import { Button } from '@rp/ui/components/button';
import { addToCartAction } from '@/app/(shop)/cart/actions';

type AddToCartButtonProps = {
  menuItemId: string;
  /**
   * The current page path. Used by the server action to (a) sanitize via
   * `safeNextPath` and compose `/login?next=…` for anonymous users,
   * (b) `revalidatePath` the rendering page after a successful add. The
   * RSC that rendered this button supplies the value.
   */
  currentPath: string;
};

/**
 * Client component. Posts to `addToCartAction` via FormData. Server action
 * handles validation, cart resolution, and (if unauthenticated) the
 * redirect to `/login?next=<currentPath>`.
 *
 * Replaces the disabled stub button from PR 25a.
 *
 * DEL-25 PR 25b.
 */
export function AddToCartButton({ menuItemId, currentPath }: AddToCartButtonProps) {
  const [pending, startTransition] = useTransition();
  return (
    <form
      action={(formData) => {
        formData.set('menuItemId', menuItemId);
        formData.set('currentPath', currentPath);
        startTransition(async () => {
          await addToCartAction(formData);
        });
      }}
    >
      <Button type="submit" disabled={pending} className="self-center">
        {pending ? 'Adding…' : 'Add'}
      </Button>
    </form>
  );
}
