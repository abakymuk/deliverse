import { ResetPasswordForm } from '@/components/auth/reset-password-form';
import { Suspense } from 'react';

export const metadata = {
  title: 'Reset password',
};

export default function ResetPasswordPage() {
  return (
    <div className="flex min-h-svh w-full items-center justify-center p-6 md:p-10">
      <div className="w-full max-w-sm">
        <Suspense fallback={null}>
          <ResetPasswordForm />
        </Suspense>
      </div>
    </div>
  );
}
