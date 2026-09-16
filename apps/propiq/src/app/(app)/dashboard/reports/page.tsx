import type { Metadata } from 'next';
import Link from 'next/link';
import { FileText } from 'lucide-react';
import { asId } from '@/domain/shared/types';
import type { PropertyId } from '@/domain/shared/types';
import { buildPropertyIntelligence } from '@/server/intelligence';
import type { PropertyIntelligence } from '@/server/intelligence';
import { currentUserId } from '@/server/actions';
import { getWatchlistRepository } from '@/server/watchlist';
import { DecisionBadge } from '@/components/propiq/decision-badge';
import { formatDate } from '@/lib/utils';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Reports',
  description: 'Generate a frozen intelligence report for any property you track.',
  robots: { index: false, follow: false },
};

export default async function ReportsPage() {
  const userId = await currentUserId();
  const entries = userId ? await getWatchlistRepository().list(userId) : [];
  const loaded = await Promise.all(
    entries.map((e) =>
      buildPropertyIntelligence(asId<PropertyId>(e.propertyId), { includeAlternatives: false }),
    ),
  );
  const intel = loaded.filter((x): x is PropertyIntelligence => x !== undefined);

  return (
    <div className="mx-auto max-w-4xl px-4 py-8">
      <h1 className="text-2xl font-semibold tracking-tight">Reports</h1>
      <p className="mb-6 mt-1 max-w-2xl text-sm text-[var(--text-secondary)]">
        A report is a frozen statement of what PropIQ knew at a moment in time, carrying the scoring
        and methodology versions it was produced under, so the conclusion can be re-derived later
        rather than taken on trust.
      </p>

      {!userId ? (
        <Empty
          title="Sign in to generate reports"
          body="Reports are built from the properties on your watchlist."
          href="/login"
          cta="Sign in"
        />
      ) : intel.length === 0 ? (
        <Empty
          title="Nothing to report on yet"
          body="Save a property and you can generate a full intelligence report for it here."
          href="/search"
          cta="Find properties"
        />
      ) : (
        <ul className="space-y-3">
          {intel.map((i) => (
            <li
              key={i.property.id}
              className="flex flex-wrap items-center gap-3 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-1)] p-4"
            >
              <FileText aria-hidden className="size-4 shrink-0 text-[var(--text-accent)]" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{i.property.title}</p>
                <p className="text-xs text-[var(--text-muted)]">
                  Scoring v{i.score.scoringVersion} · evidence as of {formatDate(i.computedAt)}
                </p>
              </div>
              <DecisionBadge decision={i.decision.decision} size="sm" />
              <Link
                href={`/property/${i.property.id}/report`}
                className="inline-flex h-9 shrink-0 items-center rounded-md bg-accent-500 px-3 text-xs font-semibold text-[#0a2a2b] hover:bg-accent-400"
              >
                Open report
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const Empty = ({
  title,
  body,
  href,
  cta,
}: {
  title: string;
  body: string;
  href: string;
  cta: string;
}) => (
  <div className="rounded-lg border border-dashed border-[var(--border-strong)] p-10 text-center">
    <p className="text-sm font-medium">{title}</p>
    <p className="mx-auto mt-1 max-w-md text-xs text-[var(--text-secondary)]">{body}</p>
    <Link
      href={href}
      className="mt-4 inline-flex h-10 items-center rounded-md bg-accent-500 px-4 text-sm font-semibold text-[#0a2a2b] hover:bg-accent-400"
    >
      {cta}
    </Link>
  </div>
);
