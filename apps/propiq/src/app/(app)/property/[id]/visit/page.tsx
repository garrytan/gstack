import { notFound } from 'next/navigation';
import { cache } from 'react';
import Link from 'next/link';
import type { Metadata } from 'next';
import { asId } from '@/domain/shared/types';
import type { PropertyId } from '@/domain/shared/types';
import { CHECKLIST } from '@/domain/visits/checklist';
import { summariseVisit } from '@/domain/visits/engine';
import { buildPropertyIntelligence } from '@/server/intelligence';
import { currentUserId, loadVisits, scheduleVisit } from '@/server/actions';
import { VisitChecklist } from '@/components/propiq/visit-checklist';
import { ScheduleVisitForm } from '@/components/propiq/schedule-visit-form';
import { TrackView } from '@/components/propiq/track-view';
import { formatDate } from '@/lib/utils';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };

const loadProperty = cache(async (id: string) =>
  buildPropertyIntelligence(asId<PropertyId>(id), { includeAlternatives: false }),
);

export const generateMetadata = async ({ params }: Params): Promise<Metadata> => {
  const { id } = await params;
  const intel = await loadProperty(id);
  if (!intel) notFound();
  return {
    title: `Site visit — ${intel.property.title}`,
    description: `A ${CHECKLIST.length}-point site visit checklist for ${intel.property.title}.`,
    robots: { index: false, follow: false },
  };
};

export default async function VisitPage({ params }: Params) {
  const { id } = await params;
  const intel = await loadProperty(id);
  if (!intel) notFound();

  const userId = await currentUserId();
  const visits = userId ? await loadVisits(id) : [];
  const live = visits.find((v) => v.status !== 'cancelled');

  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <TrackView event="visit_requested" properties={{ propertyId: id }} />

      <nav aria-label="Breadcrumb" className="mb-4 text-xs text-[var(--text-muted)]">
        <Link href={`/property/${id}`} className="hover:underline">
          ← {intel.property.title}
        </Link>
      </nav>

      <h1 className="text-2xl font-semibold tracking-tight">Site visit</h1>
      <p className="mt-2 max-w-2xl text-sm text-[var(--text-secondary)]">
        {CHECKLIST.length} things you can only learn by standing there. Every one has cost somebody
        money by being skipped, and what you record becomes evidence on this property — the only
        first-party evidence PropIQ holds.
      </p>

      {!userId ? (
        <SignedOut propertyId={id} />
      ) : live ? (
        <>
          <p className="mt-4 text-xs text-[var(--text-muted)]">
            Visit {live.status === 'completed' ? 'recorded' : 'planned'} for{' '}
            {formatDate(`${live.scheduledFor}T00:00:00.000Z`)}
            {live.status === 'completed' &&
              ` · ${summariseVisit(live).answered} of ${CHECKLIST.length} answered`}
          </p>
          <div className="mt-6">
            <VisitChecklist visit={live} />
          </div>
        </>
      ) : (
        <div className="mt-6">
          <ScheduleVisitForm propertyId={id} action={scheduleVisit} />
          <section className="mt-8">
            <h2 className="text-sm font-semibold">What you will be asked</h2>
            <ul className="mt-3 space-y-1">
              {CHECKLIST.map((c) => (
                <li key={c.id} className="text-xs text-[var(--text-secondary)]">
                  • {c.question}
                </li>
              ))}
            </ul>
          </section>
        </div>
      )}
    </div>
  );
}

const SignedOut = ({ propertyId }: { propertyId: string }) => (
  <div className="mt-6 rounded-lg border border-dashed border-[var(--border-strong)] p-10 text-center">
    <p className="text-sm font-medium">Sign in to record a visit</p>
    <p className="mx-auto mt-1 max-w-md text-xs text-[var(--text-secondary)]">
      What you see on site becomes evidence on your copy of this property. It is private to your
      account and never pooled into anyone else&rsquo;s score.
    </p>
    <Link
      href="/login"
      className="mt-4 inline-flex h-10 items-center rounded-md bg-accent-500 px-4 text-sm font-semibold text-ink-950 hover:bg-accent-400"
    >
      Sign in
    </Link>
    <p className="mt-4 text-xs text-[var(--text-muted)]">
      Or just{' '}
      <Link href={`/property/${propertyId}`} className="text-accent-500 hover:underline">
        read the checklist above
      </Link>{' '}
      and take it with you.
    </p>
  </div>
);
