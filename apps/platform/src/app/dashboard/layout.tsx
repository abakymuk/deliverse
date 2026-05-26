import { AcceptInvitationHook } from '@/components/auth/accept-invitation-hook';
import { auth } from '@/lib/auth';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { Suspense } from 'react';

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth.api.getSession({
    headers: await headers(),
  });

  if (!session) {
    redirect('/login');
  }

  return (
    <div className="min-h-screen">
      {/* AcceptInvitationHook reads ?accept=<invitationId> from the URL and
       * calls organization.acceptInvitation. Required because Next 16 server
       * layouts don't receive searchParams — only pages do. Per docs/specs/
       * auth-ui.md §3 decision + §8. Idempotent + non-fatal on prior accept. */}
      <Suspense fallback={null}>
        <AcceptInvitationHook />
      </Suspense>
      <header className="border-b">
        <div className="container mx-auto flex h-16 items-center justify-between px-6">
          <h1 className="font-semibold">Restaurant Platform</h1>
          <div className="text-sm">{session.user.email}</div>
        </div>
      </header>
      <main className="container mx-auto p-6">{children}</main>
    </div>
  );
}
