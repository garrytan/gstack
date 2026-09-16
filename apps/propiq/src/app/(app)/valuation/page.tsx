import type { Metadata } from 'next';
import Link from 'next/link';
import { getPropertyRepository } from '@/data';
import { buildPropertyIntelligence } from '@/server/intelligence';
import type { PropertyIntelligence } from '@/server/intelligence';
import { MIN_COMPARABLES, VALUATION_METHODOLOGY_VERSION } from '@/domain/valuation/engine';
import { DemoDataBanner } from '@/components/propiq/data-status';
import { ValuationBand } from '@/components/propiq/valuation-band';
import { TrackView } from '@/components/propiq/track-view';
import { formatDate, formatPsf } from '@/lib/utils';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Fair value',
  description:
    'How PropIQ values a property: comparable adjustment, weighting, and an honest range rather than false precision.',
  alternates: { canonical: '/valuation' },
};

export default async function ValuationPage({
  searchParams,
}: {
  searchParams: Promise<{ property?: string }>;
}) {
  const { property } = await searchParams;
  const repo = getPropertyRepository();

  const id = property && /^[a-zA-Z0-9_-]+$/.test(property) ? property : undefined;
  let intel: PropertyIntelligence | undefined;
  if (id) {
    intel = await buildPropertyIntelligence(id as never);
  } else {
    const { items } = await repo.search({ pageSize: 1, sort: 'priceDesc' });
    if (items[0]) intel = await buildPropertyIntelligence(items[0].id);
  }

  return (
    <div className="mx-auto max-w-4xl px-4 py-10">
      {intel && (
        <TrackView event="valuation_completed" properties={{ propertyId: intel.property.id }} />
      )}
      {repo.servesDemoData && <DemoDataBanner className="mb-6" />}

      <h1 className="text-3xl font-semibold tracking-tight">Fair value</h1>
      <p className="mt-3 text-base text-[var(--text-secondary)]">
        PropIQ values a property against comparables adjusted onto its terms, and reports a range
        with a confidence rather than a single confident number. Indian residential comparables are
        sparse and heterogeneous; two-decimal precision would be a lie told neatly.
      </p>

      {intel ? (
        <>
          <p className="mt-6 text-sm text-[var(--text-secondary)]">
            Worked example —{' '}
            <Link
              href={`/property/${intel.property.id}`}
              className="text-[var(--text-accent)] hover:underline"
            >
              {intel.property.title}
            </Link>
          </p>
          <div className="mt-3">
            <ValuationBand valuation={intel.valuation} negotiation={intel.negotiation} />
          </div>

          {intel.valuation.comparables.length > 0 && (
            <section className="mt-8">
              <h2 className="text-lg font-semibold tracking-tight">
                The comparables, and what we did to them
              </h2>
              <div className="mt-3 overflow-x-auto">
                <table className="w-full min-w-[720px] border-collapse text-sm">
                  <caption className="sr-only">Comparable set with adjustments and weights</caption>
                  <thead>
                    <tr className="border-b border-[var(--border-strong)] text-left text-xs">
                      <th scope="col" className="py-2 pr-4 font-semibold">
                        Comparable
                      </th>
                      <th scope="col" className="py-2 pr-4 text-right font-semibold">
                        Observed
                      </th>
                      <th scope="col" className="py-2 pr-4 text-right font-semibold">
                        ₹/sqft
                      </th>
                      <th scope="col" className="py-2 pr-4 text-right font-semibold">
                        Distance
                      </th>
                      <th scope="col" className="py-2 pr-4 text-right font-semibold">
                        Weight
                      </th>
                      <th scope="col" className="py-2 font-semibold">
                        Adjustments
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {intel.valuation.comparables.map((c) => (
                      <tr
                        key={c.label}
                        className="border-b border-[var(--border-subtle)] align-top"
                      >
                        <th scope="row" className="py-2 pr-4 text-left text-xs font-medium">
                          {c.label}
                        </th>
                        <td data-figure className="py-2 pr-4 text-right text-xs">
                          {formatDate(c.soldOrListedAt)}
                        </td>
                        <td data-figure className="py-2 pr-4 text-right text-xs">
                          {formatPsf(c.pricePerSqFt)}
                        </td>
                        <td data-figure className="py-2 pr-4 text-right text-xs">
                          {c.distanceKm} km
                        </td>
                        <td data-figure className="py-2 pr-4 text-right text-xs">
                          {c.weight !== undefined ? `${Math.round(c.weight * 100)}%` : '—'}
                        </td>
                        <td className="py-2 text-xs text-[var(--text-secondary)]">
                          {c.adjustments?.length ? (
                            <ul className="space-y-0.5">
                              {c.adjustments.map((a) => (
                                <li key={a.factor}>
                                  <span className="font-mono text-[10px]">
                                    {a.factor} ×{a.multiplier}
                                  </span>{' '}
                                  — {a.reason}
                                </li>
                              ))}
                            </ul>
                          ) : (
                            'none'
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </>
      ) : (
        <p className="mt-6 text-sm text-[var(--text-muted)]">
          No property is available to value in this environment.
        </p>
      )}

      <section className="mt-10">
        <h2 className="text-lg font-semibold tracking-tight">
          Method, v{VALUATION_METHODOLOGY_VERSION}
        </h2>
        <ol className="mt-3 list-decimal space-y-1.5 pl-5 text-sm text-[var(--text-secondary)]">
          <li>Collect comparables within 6 km and 730 days, on a carpet-area basis.</li>
          <li>Adjust each for time, listing-versus-transaction, floor, age and size.</li>
          <li>Weight by recency, proximity, size similarity and transaction quality.</li>
          <li>Take the weighted mean as the central estimate.</li>
          <li>Set the band from weighted dispersion, widened when the set is thin.</li>
          <li>
            Publish nothing below {MIN_COMPARABLES} usable comparables. Every run is stored so any
            historical valuation can be replayed.
          </li>
        </ol>
      </section>
    </div>
  );
}
