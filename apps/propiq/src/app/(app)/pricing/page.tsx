import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = {
  title: 'Pricing',
  description: 'PropIQ pricing.',
  alternates: { canonical: '/pricing' },
};

export default function PricingPage() {
  return (
    <div className="mx-auto max-w-3xl px-4 py-12">
      <h1 className="text-3xl font-semibold tracking-tight">Pricing</h1>
      <p className="mt-3 text-base text-[var(--text-secondary)]">
        Pricing is not set yet, and PropIQ will not show you invented plans and invented prices to
        fill a page. Billing sits behind buyer intelligence in the build order on purpose: the
        product has to be worth paying for before there is anything to charge for.
      </p>

      <div className="mt-6 rounded-lg border border-[var(--border-strong)] bg-[var(--surface-1)] p-5">
        <p className="text-sm font-semibold">Status: NOT BUILT</p>
        <p className="mt-2 text-sm text-[var(--text-secondary)]">
          The payment abstraction is designed to sit behind a provider interface so either Razorpay
          or Stripe can be dropped in without touching domain code. No provider is wired up.
        </p>
      </div>

      <p className="mt-6 text-sm text-[var(--text-secondary)]">
        In the meantime, everything on the site is open:{' '}
        <Link href="/search" className="text-[var(--text-accent)] hover:underline">
          search
        </Link>
        ,{' '}
        <Link href="/compare" className="text-[var(--text-accent)] hover:underline">
          the Decision Room
        </Link>
        , and{' '}
        <Link href="/methodology" className="text-[var(--text-accent)] hover:underline">
          the full methodology
        </Link>
        .
      </p>
    </div>
  );
}
