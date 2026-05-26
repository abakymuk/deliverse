'use client';

/**
 * AcceptInvitationHook — client component.
 *
 * Reads `?accept=<invitationId>` from the URL via `useSearchParams()` (Next 16
 * server layouts don't receive `searchParams`, only pages do — so this must
 * be a client component). On mount with a non-null `accept`, calls
 * `organization.acceptInvitation({ invitationId })` then strips the query.
 *
 * Per docs/specs/auth-ui.md §4 decision #9 + §8: don't assume BA's
 * `acceptInvitation` swallows "already accepted" / "already member" silently
 * — catch + log + continue.
 *
 * Mounted inside a `<Suspense>` boundary by the dashboard layout (or page),
 * because `useSearchParams()` requires it in Next 16 App Router.
 */

import { organization } from '@/lib/auth-client';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useRef } from 'react';

export function AcceptInvitationHook() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const accept = searchParams.get('accept');
  const ranRef = useRef(false);

  useEffect(() => {
    if (!accept || ranRef.current) return;
    ranRef.current = true;
    void (async () => {
      try {
        await organization.acceptInvitation({ invitationId: accept });
      } catch (err) {
        // "already accepted" / "already member" / token already consumed —
        // non-fatal. Log for debugging; continue to strip the query so the
        // dashboard URL is clean on refresh.
        console.warn('[accept-invitation-hook] acceptInvitation rejected:', err);
      } finally {
        router.replace('/dashboard');
      }
    })();
  }, [accept, router]);

  return null;
}
