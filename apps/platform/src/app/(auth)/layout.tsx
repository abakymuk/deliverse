/**
 * Layout for auth screens (login, signup, etc.)
 * Centered card design from shadcn/ui blocks.
 */

export default function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-sm">
        {children}
      </div>
    </div>
  );
}
