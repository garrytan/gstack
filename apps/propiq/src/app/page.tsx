import Link from 'next/link';
import { ArrowRight, FileSearch, Gavel, ScanSearch, ShieldCheck } from 'lucide-react';
import { getPropertyRepository } from '@/data';
import { buildSummaries } from '@/server/intelligence';
import { DemoDataBanner } from '@/components/propiq/data-status';
import { PropertyCard } from '@/components/propiq/property-card';
import { SearchBar } from '@/components/propiq/search-bar';
import { TrackView } from '@/components/propiq/track-view';

export const dynamic = 'force-dynamic';

const JOURNEY = [
  { label: 'Discover', detail: 'Find the shortlist that matches how you actually buy.' },
  { label: 'Verify', detail: 'RERA, developer record and title signals, with dates on them.' },
  { label: 'Compare', detail: 'Side by side on the dimensions that decide it.' },
  { label: 'Score', detail: 'Twelve pillars, persona-weighted, published formula.' },
  { label: 'Analyze', detail: 'Fair value, yield, IRR, and what breaks the model.' },
  { label: 'Negotiate', detail: 'An opening number and a walk-away number.' },
] as const;

export default async function HomePage() {
  const repo = getPropertyRepository();
  const { items } = await repo.search({ pageSize: 3, sort: 'priceDesc' });
  const featured = await buildSummaries(items);

  return (
    <>
      <TrackView event="property_viewed" properties={{ surface: 'home' }} />

      <section className="border-b border-[var(--border-subtle)]">
        <div className="mx-auto max-w-7xl px-4 py-14 sm:py-20">
          {repo.servesDemoData && <DemoDataBanner className="mb-8" />}

          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-accent-500">
            Property decision intelligence
          </p>
          <h1 className="mt-4 max-w-3xl text-4xl font-semibold tracking-tight sm:text-5xl">
            Know what it is worth before you are asked to sign.
          </h1>
          <p className="mt-4 max-w-2xl text-lg text-[var(--text-secondary)]">
            PropIQ scores a property on twelve pillars, shows you the evidence behind every one of
            them, and tells you whether to buy, negotiate, watch or walk. When the evidence is thin,
            it says so instead of guessing.
          </p>

          <div className="mt-8 max-w-2xl">
            <SearchBar />
          </div>

          <dl className="mt-10 grid max-w-3xl grid-cols-2 gap-x-8 gap-y-4 sm:grid-cols-4">
            <Metric label="Scoring pillars" value="12" />
            <Metric label="Risk dimensions" value="9" />
            <Metric label="Verdicts" value="5" />
            <Metric label="Black-box scores" value="0" />
          </dl>
        </div>
      </section>

      <section className="mx-auto max-w-7xl px-4 py-12">
        <h2 className="text-xs font-semibold uppercase tracking-[0.2em] text-[var(--text-muted)]">
          The journey
        </h2>
        <ol className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {JOURNEY.map((step, i) => (
            <li
              key={step.label}
              className="rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-1)] p-4"
            >
              <span data-figure className="text-[10px] font-semibold text-accent-500">
                {String(i + 1).padStart(2, '0')}
              </span>
              <p className="mt-1 text-sm font-semibold">{step.label}</p>
              <p className="mt-1 text-xs text-[var(--text-secondary)]">{step.detail}</p>
            </li>
          ))}
        </ol>
      </section>

      <section className="mx-auto max-w-7xl px-4 py-8">
        <div className="flex items-end justify-between gap-4">
          <div>
            <h2 className="text-xl font-semibold tracking-tight">Properties, scored</h2>
            <p className="mt-1 text-sm text-[var(--text-secondary)]">
              Every card carries its verdict, its score, and the data status behind it.
            </p>
          </div>
          <Link
            href="/search"
            className="inline-flex shrink-0 items-center gap-1 text-sm font-medium text-accent-500 hover:underline"
          >
            See all <ArrowRight aria-hidden className="size-4" />
          </Link>
        </div>

        <div className="mt-5 grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          {featured.map((intel) => (
            <PropertyCard key={intel.property.id} intelligence={intel} />
          ))}
        </div>
      </section>

      <section className="mx-auto max-w-7xl px-4 py-12">
        <h2 className="text-xl font-semibold tracking-tight">What PropIQ refuses to do</h2>
        <div className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Promise
            icon={ScanSearch}
            title="No invented facts"
            body="If we do not have a number, the field reads unknown. The scoring engine excludes it and rescales, so a gap never reads as a zero."
          />
          <Promise
            icon={ShieldCheck}
            title="No black-box scoring"
            body="Every pillar expands into its signals, the raw value observed, and the exact normalisation applied. The weights are published."
          />
          <Promise
            icon={FileSearch}
            title="No stale data in disguise"
            body="Every figure carries an observation date and decays in confidence against its source's half-life. A year-old asking price is not evidence."
          />
          <Promise
            icon={Gavel}
            title="No paid verdicts"
            body="Commercial relationships are disclosed on every property and are computed in a system that the scoring engine cannot read."
          />
        </div>
      </section>
    </>
  );
}

const Metric = ({ label, value }: { label: string; value: string }) => (
  <div>
    <dt className="text-[11px] uppercase tracking-wide text-[var(--text-muted)]">{label}</dt>
    <dd data-figure className="mt-0.5 text-2xl font-semibold">
      {value}
    </dd>
  </div>
);

const Promise = ({
  icon: Icon,
  title,
  body,
}: {
  icon: typeof ShieldCheck;
  title: string;
  body: string;
}) => (
  <article className="rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-1)] p-4">
    <Icon aria-hidden className="size-5 text-accent-500" />
    <h3 className="mt-3 text-sm font-semibold">{title}</h3>
    <p className="mt-1.5 text-xs leading-relaxed text-[var(--text-secondary)]">{body}</p>
  </article>
);
