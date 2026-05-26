import { ForgotPasswordForm } from '@/components/auth/forgot-password-form';
import { Suspense } from 'react';

export const metadata = {
  title: 'Forgot password — Restaurant Platform',
};

export default function ForgotPasswordPage() {
  return (
    <div className="flex min-h-svh w-full items-center justify-center p-6 md:p-10">
      <div className="w-full max-w-sm">
        <Suspense fallback={null}>
          <ForgotPasswordForm />
        </Suspense>
      </div>
    </div>
  );
}
