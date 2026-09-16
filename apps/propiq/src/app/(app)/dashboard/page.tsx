import type { Metadata } from 'next';
import Link from 'next/link';
import { Bell, Bookmark, FileText, Inbox, SlidersHorizontal, Wallet } from 'lucide-react';
import { currentUserId } from '@/server/actions';
import { getWatchlistRepository } from '@/server/watchlist';
import { getPropertyRepository } from '@/data';
import { DemoDataBanner } from '@/components/propiq/data-status';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Dashboard',
  description: 'Your saved properties, portfolio, alerts and reports.',
  robots: { index: false, follow: false },
};

const CARDS = [
  {
    href: '/dashboard/watchlist',
    label: 'Watchlist',
    icon: Bookmark,
    blurb: 'Properties you are tracking, with their current verdict.',
  },
  {
    href: '/dashboard/portfolio',
    label: 'Portfolio',
    icon: Wallet,
    blurb: 'What you own, what it earns and what it is worth now.',
  },
  {
    href: '/dashboard/alerts',
    label: 'Alerts',
    icon: Bell,
    blurb: 'Price, possession, RERA and risk changes on what you track.',
  },
  {
    href: '/dashboard/reports',
    label: 'Reports',
    icon: FileText,
    blurb: 'Frozen intelligence reports you can print or share.',
  },
  {
    href: '/dashboard/notifications',
    label: 'Notifications',
    icon: Inbox,
    blurb: 'Every alert that cleared a threshold, and where alerts are delivered.',
  },
  {
    href: '/preferences',
    label: 'Preferences',
    icon: SlidersHorizontal,
    blurb: 'How you buy. Changes the pillar weights behind every score you see.',
  },
] as const;

export default async function DashboardPage() {
  const repo = getPropertyRepository();
  const userId = await currentUserId();
  const saved = userId ? await getWatchlistRepository().list(userId) : [];

  return (
    <div className="mx-auto max-w-7xl px-4 py-8">
      {repo.servesDemoData && <DemoDataBanner className="mb-6" />}

      <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
      <p className="mt-1 text-sm text-[var(--text-secondary)]">
        {userId
          ? `${saved.length} propert${saved.length === 1 ? 'y' : 'ies'} on your watchlist.`
          : 'Sign in to save properties, track changes and build a portfolio.'}
      </p>

      <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {CARDS.map((c) => (
          <Link
            key={c.href}
            href={c.href}
            className="rounded-lg propiq-card p-4 transition-colors hover:border-[var(--border-strong)]"
          >
            <c.icon aria-hidden className="size-5 text-[var(--text-accent)]" />
            <p className="mt-3 text-sm font-semibold">{c.label}</p>
            <p className="mt-1 text-xs text-[var(--text-secondary)]">{c.blurb}</p>
          </Link>
        ))}
      </div>
    </div>
  );
}
