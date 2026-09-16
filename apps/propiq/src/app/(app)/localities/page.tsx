import type { Metadata } from 'next';
import Link from 'next/link';
import { getPropertyRepository } from '@/data';
import { priceCagrPercent, supplyOverhangMonths, bestCommute } from '@/domain/locality/types';
import { DemoDataBanner, DataStatusBadge, NoDataNotice } from '@/components/propiq/data-status';
import { formatPercent, formatPsf } from '@/lib/utils';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Localities',
  description:
    'Locality intelligence for the covered market: prices, rent, supply overhang, commute, infrastructure and environmental risk.',
  alternates: { canonical: '/localities' },
};

export default async function LocalitiesPage() {
  const repo = getPropertyRepository();
  const localities = await repo.listLocalities();

  return (
    <div className="mx-auto max-w-7xl px-4 py-8">
      {repo.servesDemoData && <DemoDataBanner className="mb-6" />}
      {repo.servesNoData && <NoDataNotice surface="Locality intelligence" />}

      <h1 className="text-2xl font-semibold tracking-tight">Localities</h1>
      <p className="mt-1 max-w-2xl text-sm text-[var(--text-secondary)]">
        PropIQ covers one market densely rather than a hundred thinly. Every figure below carries a
        methodology and a date; none of them is a vibe.
      </p>

      <div className="mt-6 overflow-x-auto">
        <table className="w-full min-w-[840px] border-collapse text-sm">
          <caption className="sr-only">Locality market indicators</caption>
          <thead>
            <tr className="border-b border-[var(--border-strong)] text-left text-xs">
              <th scope="col" className="py-2 pr-4 font-semibold">
                Locality
              </th>
              <th scope="col" className="py-2 pr-4 text-right font-semibold">
                Median ₹/sqft
              </th>
              <th scope="col" className="py-2 pr-4 text-right font-semibold">
                Price CAGR
              </th>
              <th scope="col" className="py-2 pr-4 text-right font-semibold">
                Gross yield
              </th>
              <th scope="col" className="py-2 pr-4 text-right font-semibold">
                Supply overhang
              </th>
              <th scope="col" className="py-2 pr-4 text-right font-semibold">
                Peak commute
              </th>
              <th scope="col" className="py-2 pr-4 text-right font-semibold">
                PM2.5
              </th>
              <th scope="col" className="py-2 font-semibold">
                Data
              </th>
            </tr>
          </thead>
          <tbody>
            {localities.map((l) => {
              const overhang = supplyOverhangMonths(l);
              const cagr = priceCagrPercent(l.priceHistory);
              const commute = bestCommute(l);
              return (
                <tr key={l.id} className="border-b border-[var(--border-subtle)]">
                  <th scope="row" className="py-2.5 pr-4 text-left">
                    <Link
                      href={`/locality/${l.slug}`}
                      className="text-sm font-medium hover:underline"
                    >
                      {l.name}
                    </Link>
                  </th>
                  <td data-figure className="py-2.5 pr-4 text-right text-xs">
                    {l.currentMedianPricePerSqFt ? formatPsf(l.currentMedianPricePerSqFt) : '—'}
                  </td>
                  <td data-figure className="py-2.5 pr-4 text-right text-xs">
                    {formatPercent(cagr)}
                  </td>
                  <td data-figure className="py-2.5 pr-4 text-right text-xs">
                    {formatPercent(l.grossRentalYieldPercent, 2)}
                  </td>
                  <td data-figure className="py-2.5 pr-4 text-right text-xs">
                    {overhang === undefined ? '—' : `${Math.round(overhang)} months`}
                  </td>
                  <td data-figure className="py-2.5 pr-4 text-right text-xs">
                    {commute ? `${commute.peakCommuteMinutes} min` : '—'}
                  </td>
                  <td data-figure className="py-2.5 pr-4 text-right text-xs">
                    {l.environment.pm25Annual ?? '—'}
                  </td>
                  <td className="py-2.5">
                    <DataStatusBadge status={l.dataStatus} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="mt-4 text-xs text-[var(--text-muted)]">
        Supply overhang is unsold inventory divided by trailing absorption, expressed in months.
        Above roughly 24 months is a buyer&rsquo;s market.
      </p>
    </div>
  );
}
