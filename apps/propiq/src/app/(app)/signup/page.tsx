import type { Metadata } from 'next';
import { Suspense } from 'react';
import { AuthForm } from '@/components/propiq/auth-form';

export const metadata: Metadata = {
  title: 'Create an account',
  description: 'Create a PropIQ account to save properties and track what changes.',
  robots: { index: true, follow: true },
  alternates: { canonical: '/signup' },
};

export default function SignupPage() {
  return (
    <Suspense
      fallback={
        <div className="mx-auto max-w-md px-4 py-14">
          <div className="skeleton h-64 rounded-lg" />
        </div>
      }
    >
      <AuthForm mode="signup" />
    </Suspense>
  );
}
