'use client';

import { Button } from '@rp/ui/components/button';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { signOut } from '@/lib/auth-client';

/**
 * Sign-out button — client component. Calls BA's `signOut`, then
 * navigates to `/login` and refreshes the router so the proxy + RSC
 * tree re-evaluate auth state (the session cookie is cleared by BA
 * server-side via the signout endpoint).
 *
 * Lives in `/account` today (the only page that needs it); promote
 * to a shared header component if a second consumer ever appears.
 */
export function SignOutButton() {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  async function handleClick() {
    setPending(true);
    try {
      await signOut();
    } catch {
      // Best-effort: even if BA's signout call errors (network blip,
      // session already gone), still kick the user to /login so they
      // can re-authenticate.
    }
    router.push('/login');
    router.refresh();
  }

  return (
    <Button type="button" variant="outline" onClick={handleClick} disabled={pending}>
      {pending ? 'Signing out…' : 'Sign out'}
    </Button>
  );
}
