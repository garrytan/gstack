import type { Metadata } from 'next';
import Link from 'next/link';
import { asId } from '@/domain/shared/types';
import type { PropertyId } from '@/domain/shared/types';
import { currentUserId } from '@/server/actions';
import { getWatchlistRepository } from '@/server/watchlist';
import { buildPropertyIntelligence } from '@/server/intelligence';
import type { PropertyIntelligence } from '@/server/intelligence';
import { getPropertyRepository } from '@/data';
import { DemoDataBanner } from '@/components/propiq/data-status';
import { PropertyCard } from '@/components/propiq/property-card';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Watchlist',
  description: 'Properties you are tracking.',
  robots: { index: false, follow: false },
};

export default async function WatchlistPage() {
  const repo = getPropertyRepository();
  const userId = await currentUserId();

  if (!userId) {
    return (
      <Shell>
        <div className="rounded-lg border border-dashed border-[var(--border-strong)] p-10 text-center">
          <p className="text-sm font-medium">Sign in to use your watchlist</p>
          <p className="mx-auto mt-1 max-w-md text-xs text-[var(--text-secondary)]">
            Saved properties are tied to your account so alerts can reach you when a price, a
            possession date or a RERA status changes.
          </p>
          <Link
            href="/login"
            className="mt-4 inline-flex h-10 items-center rounded-md bg-accent-500 px-4 text-sm font-semibold text-ink-950 hover:bg-accent-400"
          >
            Sign in
          </Link>
        </div>
      </Shell>
    );
  }

  const entries = await getWatchlistRepository().list(userId);
  const loaded = await Promise.all(
    entries.map((e) =>
      buildPropertyIntelligence(asId<PropertyId>(e.propertyId), { includeAlternatives: false }),
    ),
  );
  const intel = loaded.filter((x): x is PropertyIntelligence => x !== undefined);

  return (
    <Shell>
      {repo.servesDemoData && <DemoDataBanner className="mb-6" />}

      {intel.length === 0 ? (
        <div className="rounded-lg border border-dashed border-[var(--border-strong)] p-10 text-center">
          <p className="text-sm font-medium">Nothing saved yet</p>
          <p className="mx-auto mt-1 max-w-md text-xs text-[var(--text-secondary)]">
            Save a property from search or from its intelligence page and it will appear here with
            its live verdict.
          </p>
          <Link
            href="/search"
            className="mt-4 inline-flex h-10 items-center rounded-md bg-accent-500 px-4 text-sm font-semibold text-ink-950 hover:bg-accent-400"
          >
            Start searching
          </Link>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
            {intel.map((i) => (
              <PropertyCard key={i.property.id} intelligence={i} />
            ))}
          </div>
          {intel.length > 1 && (
            <Link
              href={`/compare?ids=${intel
                .slice(0, 4)
                .map((i) => i.property.id)
                .join(',')}`}
              className="mt-6 inline-flex h-10 items-center rounded-md border border-[var(--border-strong)] px-4 text-sm font-medium hover:bg-[var(--surface-2)]"
            >
              Compare saved properties
            </Link>
          )}
        </>
      )}
    </Shell>
  );
}

const Shell = ({ children }: { children: React.ReactNode }) => (
  <div className="mx-auto max-w-7xl px-4 py-8">
    <h1 className="text-2xl font-semibold tracking-tight">Watchlist</h1>
    <p className="mb-6 mt-1 text-sm text-[var(--text-secondary)]">
      Every saved property is re-scored on load, so the verdict you see is current rather than the
      one you saved.
    </p>
    {children}
  </div>
);
