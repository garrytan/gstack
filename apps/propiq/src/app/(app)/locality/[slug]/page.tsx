import { notFound } from 'next/navigation';
import { cache } from 'react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { getPropertyRepository } from '@/data';
import { buildSummaries } from '@/server/intelligence';
import { bestCommute, priceCagrPercent, supplyOverhangMonths } from '@/domain/locality/types';
import { DemoDataBanner, DataStatusBadge } from '@/components/propiq/data-status';
import { EvidencePanel } from '@/components/propiq/evidence-panel';
import { PropertyCard } from '@/components/propiq/property-card';
import { PriceHistoryChart } from '@/components/propiq/price-history-chart';
import { formatDate, formatPercent, formatPsf } from '@/lib/utils';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ slug: string }> };

/** Deduped per-request loader shared by generateMetadata and the page body. */
const loadLocality = cache(async (slug: string) => getPropertyRepository().getLocalityBySlug(slug));

export const generateMetadata = async ({ params }: Params): Promise<Metadata> => {
  const { slug } = await params;
  // Raised here, not in the body: see the note on the property route. A
  // force-dynamic body cannot change a status that has already been streamed.
  const locality = await loadLocality(slug);
  if (!locality) notFound();
  return {
    title: `${locality.name} property market`,
    description:
      locality.summary ??
      `Prices, rent, supply, commute and infrastructure for ${locality.name}, with sources and dates.`,
    alternates: { canonical: `/locality/${slug}` },
  };
};

export default async function LocalityPage({ params }: Params) {
  const { slug } = await params;
  const repo = getPropertyRepository();
  const locality = await loadLocality(slug);
  if (!locality) notFound();

  const { items } = await repo.search({ localityIds: [locality.id], pageSize: 6 });
  const properties = await buildSummaries(items);
  const overhang = supplyOverhangMonths(locality);
  const cagr = priceCagrPercent(locality.priceHistory);
  const commute = bestCommute(locality);

  return (
    <div className="mx-auto max-w-7xl px-4 py-8">
      {locality.dataStatus === 'demo' && <DemoDataBanner className="mb-6" />}

      <nav aria-label="Breadcrumb" className="mb-4 text-xs text-[var(--text-muted)]">
        <ol className="flex items-center gap-1.5">
          <li>
            <Link href="/" className="hover:underline">
              Home
            </Link>
          </li>
          <li aria-hidden>/</li>
          <li>
            <Link href="/localities" className="hover:underline">
              Localities
            </Link>
          </li>
          <li aria-hidden>/</li>
          <li aria-current="page" className="text-[var(--text-secondary)]">
            {locality.name}
          </li>
        </ol>
      </nav>

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{locality.name}</h1>
          {locality.summary && (
            <p className="mt-2 max-w-2xl text-sm text-[var(--text-secondary)]">
              {locality.summary}
            </p>
          )}
        </div>
        <DataStatusBadge status={locality.dataStatus} />
      </div>

      <dl className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
        <Stat
          label="Median ₹/sqft"
          value={
            locality.currentMedianPricePerSqFt ? formatPsf(locality.currentMedianPricePerSqFt) : '—'
          }
        />
        <Stat label="Price CAGR" value={formatPercent(cagr)} />
        <Stat label="Gross yield" value={formatPercent(locality.grossRentalYieldPercent, 2)} />
        <Stat
          label="Supply overhang"
          value={overhang === undefined ? '—' : `${Math.round(overhang)} months`}
        />
        <Stat
          label="Peak commute"
          value={commute ? `${commute.peakCommuteMinutes} min` : '—'}
          hint={commute?.hubName}
        />
        <Stat
          label="Metro"
          value={
            locality.transit.metroDistanceKm !== undefined
              ? `${locality.transit.metroDistanceKm} km`
              : '—'
          }
        />
      </dl>

      <section className="mt-8">
        <h2 className="text-lg font-semibold tracking-tight">Price trend</h2>
        <p className="mt-1 text-xs text-[var(--text-muted)]">
          Median asking ₹/sqft by quarter. {locality.priceHistory.length} observations.
        </p>
        <div className="mt-3">
          <PriceHistoryChart history={locality.priceHistory} />
        </div>
      </section>

      <section className="mt-8 grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Panel title="Environment">
          <Row
            label="Annual PM2.5"
            value={
              locality.environment.pm25Annual
                ? `${locality.environment.pm25Annual} µg/m³`
                : 'unknown'
            }
          />
          <Row
            label="Flood exposure"
            value={
              locality.environment.floodRisk !== undefined
                ? locality.environment.floodRisk.toFixed(2)
                : 'unknown'
            }
          />
          <Row
            label="Water stress"
            value={
              locality.environment.waterStress !== undefined
                ? locality.environment.waterStress.toFixed(2)
                : 'unknown'
            }
          />
          <Row
            label="Peak traffic index"
            value={locality.environment.averagePeakTrafficIndex?.toFixed(2) ?? 'unknown'}
          />
        </Panel>

        <Panel title="Social infrastructure">
          <Row
            label="Schools within 3 km"
            value={locality.social.schoolsWithin3Km?.toString() ?? 'unknown'}
          />
          <Row
            label="Hospitals within 5 km"
            value={locality.social.hospitalsWithin5Km?.toString() ?? 'unknown'}
          />
          <Row
            label="Parks within 2 km"
            value={locality.social.parksWithin2Km?.toString() ?? 'unknown'}
          />
          <Row
            label="Malls within 5 km"
            value={locality.social.mallsWithin5Km?.toString() ?? 'unknown'}
          />
        </Panel>

        <Panel title="Supply & demand">
          <Row
            label="Active supply"
            value={locality.activeSupplyUnits?.toLocaleString('en-IN') ?? 'unknown'}
          />
          <Row
            label="Annual absorption"
            value={locality.annualAbsorptionUnits?.toLocaleString('en-IN') ?? 'unknown'}
          />
          <Row
            label="Overhang"
            value={overhang === undefined ? 'unknown' : `${Math.round(overhang)} months`}
          />
        </Panel>
      </section>

      {locality.pipeline.length > 0 && (
        <section className="mt-8">
          <h2 className="text-lg font-semibold tracking-tight">Infrastructure pipeline</h2>
          <ul className="mt-3 space-y-2">
            {locality.pipeline.map((p) => (
              <li
                key={p.name}
                className="flex flex-wrap items-baseline gap-x-3 rounded-lg propiq-card p-3"
              >
                <span className="text-sm font-medium">{p.name}</span>
                <span className="text-xs uppercase tracking-wide text-[var(--text-muted)]">
                  {p.type}
                </span>
                <span className="text-xs font-medium text-[var(--text-accent)]">{p.status}</span>
                {p.expectedCompletion && (
                  <span className="text-xs text-[var(--text-muted)]">
                    expected {formatDate(p.expectedCompletion)}
                  </span>
                )}
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-[var(--text-muted)]">
            Only funded, under-construction and commissioned items raise the infrastructure score.
            An announcement is not infrastructure.
          </p>
        </section>
      )}

      {properties.length > 0 && (
        <section className="mt-8">
          <h2 className="text-lg font-semibold tracking-tight">Scored properties here</h2>
          <div className="mt-3 grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
            {properties.map((p) => (
              <PropertyCard key={p.property.id} intelligence={p} />
            ))}
          </div>
        </section>
      )}

      <section className="mt-8">
        <EvidencePanel evidence={locality.evidence} title="Evidence behind these figures" />
      </section>
    </div>
  );
}

const Stat = ({ label, value, hint }: { label: string; value: string; hint?: string }) => (
  <div>
    <dt className="text-[10px] uppercase tracking-wide text-[var(--text-muted)]">{label}</dt>
    <dd data-figure className="mt-0.5 text-sm font-semibold">
      {value}
    </dd>
    {hint && <p className="text-[10px] text-[var(--text-muted)]">{hint}</p>}
  </div>
);

const Panel = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <div className="rounded-lg propiq-card p-4">
    <h3 className="text-sm font-semibold">{title}</h3>
    <dl className="mt-3 space-y-1.5 text-xs">{children}</dl>
  </div>
);

const Row = ({ label, value }: { label: string; value: string }) => (
  <div className="flex justify-between gap-3">
    <dt className="text-[var(--text-muted)]">{label}</dt>
    <dd data-figure className="font-medium">
      {value}
    </dd>
  </div>
);
