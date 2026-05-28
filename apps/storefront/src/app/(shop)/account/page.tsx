import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@rp/ui/components/card';
import { headers } from 'next/headers';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { SignOutButton } from '@/components/account/sign-out-button';
import { auth } from '@/lib/auth';

/**
 * Account page — `/account`. The post-signin landing per all 5 auth
 * forms' default `next` value (login, signup, verify-otp, forgot-
 * password, reset-password). Lives in `PROTECTED_PATHS` per
 * `apps/storefront/src/proxy.ts`, so unauthenticated requests are
 * proxy-redirected to `/login?next=/account` before reaching this
 * render.
 *
 * Defense-in-depth: `notFound()` if BA returns no session (e.g.,
 * proxy bypass via internal route). Same shape as
 * `/(shop)/orders/[orderId]/page.tsx`.
 *
 * v1 surface is intentionally minimal — confirms signin worked,
 * shows the user's email + name, links back to the storefront home,
 * and exposes a sign-out button. Iterations (order history, saved
 * addresses, preferences) land as separate features under their own
 * specs.
 */
export default async function AccountPage() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user) {
    // Proxy gates /account via PROTECTED_PATHS; this is defense-in-depth.
    notFound();
  }

  const { user } = session;

  return (
    <div className="container mx-auto p-8">
      <div className="mb-6">
        <Link
          href="/"
          className="text-sm text-[var(--color-muted-foreground)] hover:underline"
        >
          ← Back to the menu
        </Link>
      </div>
      <h1 className="text-4xl font-bold">Your account</h1>
      <p className="mt-2 text-[var(--color-muted-foreground)]">
        You&apos;re signed in.
      </p>

      <div className="mt-8 max-w-xl">
        <Card>
          <CardHeader>
            <CardTitle>Profile</CardTitle>
            <CardDescription>The details linked to your account.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {user.name ? (
              <div>
                <div className="text-sm text-[var(--color-muted-foreground)]">Name</div>
                <div className="font-medium">{user.name}</div>
              </div>
            ) : null}
            <div>
              <div className="text-sm text-[var(--color-muted-foreground)]">Email</div>
              <div className="font-medium">{user.email}</div>
            </div>
          </CardContent>
        </Card>

        <div className="mt-6 flex justify-end">
          <SignOutButton />
        </div>
      </div>
    </div>
  );
}
