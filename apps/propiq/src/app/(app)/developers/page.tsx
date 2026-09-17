import type { Metadata } from 'next';
import Link from 'next/link';
import { getPropertyRepository } from '@/data';
import { buildSummaries } from '@/server/intelligence';
import { toDeveloperProfile } from '@/site/data/project';
import { DemoDataBanner, NoDataNotice } from '@/components/propiq/data-status';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Developer intelligence',
  description:
    'Delivery record, average handover delay and complaints on file for every developer in the covered market.',
  alternates: { canonical: '/developers' },
};

/**
 * Developers.
 *
 * Deliberately no composite trust score: developer track record is already a
 * weighted pillar inside the PropIQ Score, and publishing a second number
 * computed a different way would give the product two answers to one
 * question. What is shown is the record itself.
 */
export default async function DevelopersPage() {
  const repo = getPropertyRepository();
  const { items } = await repo.search({ pageSize: 48 });
  const intelligence = await buildSummaries(items);

  const seen = new Set<string>();
  const developers = [];
  for (const intel of intelligence) {
    if (!intel.developer || seen.has(intel.developer.id)) continue;
    seen.add(intel.developer.id);
    developers.push({
      profile: toDeveloperProfile(intel.developer, intel.property.dataStatus),
      properties: intelligence.filter((i) => i.developer?.id === intel.developer?.id).length,
    });
  }

  return (
    <div className="mx-auto max-w-5xl px-4 py-10">
      {repo.servesDemoData && <DemoDataBanner className="mb-6" />}
      {repo.servesNoData && <NoDataNotice surface="Developer intelligence" />}

      <h1 className="text-3xl font-semibold tracking-tight">Developer intelligence</h1>
      <p className="mt-3 max-w-2xl text-[var(--text-secondary)]">
        Who is building it, what they have delivered and how late it ran. There is no composite
        trust score here on purpose — developer record is already a weighted pillar inside the
        PropIQ Score, and a second number computed a different way would let the product give two
        answers to one question.
      </p>

      {developers.length === 0 ? (
        <p className="mt-10 rounded-lg border border-dashed border-[var(--border-strong)] p-10 text-center text-sm text-[var(--text-secondary)]">
          No developer records in the covered market yet.
        </p>
      ) : (
        <div className="mt-8 grid gap-4 sm:grid-cols-2">
          {developers.map(({ profile, properties }) => (
            <article key={profile.id} className="rounded-lg propiq-card p-5">
              <h2 className="text-base font-semibold">{profile.name}</h2>
              <p className="mt-0.5 text-xs text-[var(--text-muted)]">
                {profile.headquarters ?? 'Headquarters not recorded'}
                {profile.incorporatedYear ? ` · since ${profile.incorporatedYear}` : ''} ·{' '}
                {properties} scored {properties === 1 ? 'property' : 'properties'}
              </p>
              <dl className="mt-4 space-y-2">
                <Row label="Projects delivered" value={profile.projectsDelivered} />
                <Row label="Units delivered" value={profile.unitsDelivered} />
                <Row
                  label="Average handover delay"
                  value={profile.averageDelayMonths}
                  suffix=" months"
                />
                <Row label="RERA complaints on file" value={profile.reraComplaintsCount} />
                <Row label="Ongoing litigation" value={profile.ongoingLitigationCount} />
              </dl>
            </article>
          ))}
        </div>
      )}

      <p className="mt-8 text-xs text-[var(--text-secondary)]">
        How the developer pillar is weighted is set out in{' '}
        <Link href="/methodology" className="text-[var(--text-accent)] hover:underline">
          the published methodology
        </Link>
        .
      </p>
    </div>
  );
}

const Row = ({
  label,
  value,
  suffix = '',
}: {
  label: string;
  value: number | undefined;
  suffix?: string;
}) => (
  <div className="flex items-center justify-between gap-3 text-sm">
    <dt className="text-[var(--text-secondary)]">{label}</dt>
    <dd data-figure className="font-semibold">
      {value === undefined ? 'No record' : `${value.toLocaleString('en-IN')}${suffix}`}
    </dd>
  </div>
);
