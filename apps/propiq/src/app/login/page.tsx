import type { Metadata } from 'next';
import { Suspense } from 'react';
import { AuthForm } from '@/components/propiq/auth-form';

export const metadata: Metadata = {
  title: 'Sign in',
  description: 'Sign in to PropIQ to save properties, track changes and build a portfolio.',
  robots: { index: false, follow: true },
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ reset?: string }>;
}) {
  const { reset } = await searchParams;
  return (
    <Suspense
      fallback={
        <div className="mx-auto max-w-md px-4 py-14">
          <div className="skeleton h-64 rounded-lg" />
        </div>
      }
    >
      <AuthForm mode={reset === '1' ? 'reset' : 'signin'} />
    </Suspense>
  );
}
