import type { Metadata } from 'next';
import Link from 'next/link';
import { summarisePortfolio } from '@/domain/portfolio/calculator';
import { currentUserId, loadPortfolio } from '@/server/actions';
import { PortfolioManager } from '@/components/propiq/portfolio-manager';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Portfolio',
  description: 'What you own, what it earns and what it is worth now.',
  robots: { index: false, follow: false },
};

export default async function PortfolioPage() {
  const userId = await currentUserId();

  if (!userId) {
    return (
      <Shell>
        <div className="rounded-lg border border-dashed border-[var(--border-strong)] p-10 text-center">
          <p className="text-sm font-medium">Sign in to track a portfolio</p>
          <p className="mx-auto mt-1 max-w-md text-xs text-[var(--text-secondary)]">
            Portfolio assets are private to your account and are never used to score anyone
            else&rsquo;s property.
          </p>
          <Link
            href="/login"
            className="mt-4 inline-flex h-10 items-center rounded-md bg-accent-500 px-4 text-sm font-semibold text-white hover:bg-accent-400"
          >
            Sign in
          </Link>
        </div>
      </Shell>
    );
  }

  const assets = await loadPortfolio();
  const summary = summarisePortfolio(assets, new Date().toISOString());

  return (
    <Shell>
      <PortfolioManager summary={summary} />
    </Shell>
  );
}

const Shell = ({ children }: { children: React.ReactNode }) => (
  <div className="mx-auto max-w-7xl px-4 py-8">
    <h1 className="text-2xl font-semibold tracking-tight">Portfolio</h1>
    <p className="mb-8 mt-1 max-w-2xl text-sm text-[var(--text-secondary)]">
      Equity, yield and annualised return on what you own. Every figure is labelled with where it
      came from, because most of what we know about your own property is what you told us.
    </p>
    {children}
  </div>
);
