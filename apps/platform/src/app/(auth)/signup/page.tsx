import { SignupForm } from '@/components/auth/signup-form';
import { Suspense } from 'react';

export const metadata = {
  title: 'Sign up — Restaurant Platform',
};

export default function SignupPage() {
  return (
    <div className="flex min-h-svh w-full items-center justify-center p-6 md:p-10">
      <div className="w-full max-w-sm">
        <Suspense fallback={null}>
          <SignupForm />
        </Suspense>
      </div>
    </div>
  );
}
