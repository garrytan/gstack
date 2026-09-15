import type { Metadata } from 'next';
import Link from 'next/link';
import { getPropertyRepository } from '@/data';
import { SOURCE_TYPES, DATA_STATUSES } from '@/domain/evidence/types';
import { statusDescription } from '@/components/propiq/data-status';
import { DataStatusBadge } from '@/components/propiq/data-status';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Data sources',
  description:
    'Where PropIQ data comes from, how each class of source is classified, and what is not yet connected.',
  alternates: { canonical: '/data-sources' },
};

const SOURCE_NOTES: Readonly<Record<string, { what: string; status: string }>> = {
  rera: {
    what: 'State RERA registry filings: registration number, validity, promoter details, complaints.',
    status: 'Adapter contract defined. No live feed connected.',
  },
  registry: {
    what: 'Sub-registrar records and encumbrance certificates behind transaction comparables.',
    status: 'Adapter contract defined. No live feed connected.',
  },
  developer: {
    what: 'Developer-published price lists, cost sheets, brochures and construction updates.',
    status: 'Adapter contract defined. No live feed connected.',
  },
  listing: {
    what: 'Marketplace and broker listings. Treated as asking prices, discounted to clearing level.',
    status: 'Adapter contract defined. No live feed connected.',
  },
  transaction: {
    what: 'Observed completed transactions. The highest-weight comparable class.',
    status: 'Adapter contract defined. No live feed connected.',
  },
  survey: {
    what: 'PropIQ field surveys and site-visit capture.',
    status: 'Depends on the site-visit workflow, which is not built.',
  },
  government: {
    what: 'Municipal, census, transport-authority and pollution-board data behind locality indicators.',
    status: 'Adapter contract defined. No live feed connected.',
  },
  partner: { what: 'Contracted data-partner feeds.', status: 'No partner agreements in place.' },
  user: {
    what: 'What you tell us: portfolio assets, uploaded documents, stated preferences.',
    status: 'Live for watchlist and buyer preferences.',
  },
  model: {
    what: 'PropIQ-computed estimates: fair value, scores, risk severities, projections.',
    status: 'Live. Always labelled estimated or derived, never verified.',
  },
  fixture: {
    what: 'Development fixtures. Synthetic records used to build and test the product.',
    status: 'Live in development. Refused under NODE_ENV=production.',
  },
};

export default async function DataSourcesPage() {
  const repo = getPropertyRepository();

  return (
    <div className="mx-auto max-w-4xl px-4 py-10">
      <h1 className="text-3xl font-semibold tracking-tight">Data sources</h1>
      <p className="mt-3 text-base text-[var(--text-secondary)]">
        PropIQ is a measurement product, so it has to be honest about what it has measured. This
        page says what is connected, what is not, and how every figure is classified.
      </p>

      <div className="mt-6 rounded-lg border border-[var(--border-strong)] bg-[var(--surface-1)] p-4">
        <p className="text-sm font-semibold">This environment</p>
        <dl className="mt-2 space-y-1 text-sm">
          <div className="flex justify-between gap-3">
            <dt className="text-[var(--text-muted)]">Active adapter</dt>
            <dd className="font-mono text-xs font-semibold">{repo.adapterName}</dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt className="text-[var(--text-muted)]">Serves demo data</dt>
            <dd
              className={
                repo.servesDemoData
                  ? 'font-semibold text-[var(--color-negotiate)]'
                  : 'font-semibold'
              }
            >
              {repo.servesDemoData ? 'Yes' : 'No'}
            </dd>
          </div>
        </dl>
        {repo.servesDemoData && (
          <p className="mt-2 text-xs text-[var(--text-secondary)]">
            Everything you can see in this environment is a development fixture. The fixture adapter
            is refused outright when NODE_ENV is production, so these records cannot reach a live
            deployment.
          </p>
        )}
      </div>

      <section className="mt-10">
        <h2 className="text-lg font-semibold tracking-tight">How every figure is classified</h2>
        <dl className="mt-3 space-y-3">
          {DATA_STATUSES.map((status) => (
            <div
              key={status}
              className="rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-1)] p-3"
            >
              <dt>
                <DataStatusBadge status={status} />
              </dt>
              <dd className="mt-1.5 text-sm text-[var(--text-secondary)]">
                {statusDescription(status)}
              </dd>
            </div>
          ))}
        </dl>
        <p className="mt-3 text-sm text-[var(--text-secondary)]">
          A production adapter is forbidden from emitting demo records, and the query layer excludes
          them rather than filtering after the fact. If a demo row somehow existed in a production
          database, it would not be served.
        </p>
      </section>

      <section className="mt-10">
        <h2 className="text-lg font-semibold tracking-tight">Source classes</h2>
        <p className="mt-1 text-sm text-[var(--text-secondary)]">
          Each class carries its own trust weight and its own freshness window, published on the{' '}
          <Link href="/methodology" className="text-accent-500 hover:underline">
            methodology page
          </Link>
          .
        </p>
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[640px] border-collapse text-sm">
            <caption className="sr-only">Source classes and integration status</caption>
            <thead>
              <tr className="border-b border-[var(--border-strong)] text-left text-xs">
                <th scope="col" className="py-2 pr-4 font-semibold">
                  Class
                </th>
                <th scope="col" className="py-2 pr-4 font-semibold">
                  What it carries
                </th>
                <th scope="col" className="py-2 font-semibold">
                  Integration status
                </th>
              </tr>
            </thead>
            <tbody>
              {SOURCE_TYPES.map((t) => (
                <tr key={t} className="border-b border-[var(--border-subtle)] align-top">
                  <th scope="row" className="py-2 pr-4 text-left font-mono text-xs">
                    {t}
                  </th>
                  <td className="py-2 pr-4 text-xs text-[var(--text-secondary)]">
                    {SOURCE_NOTES[t]?.what}
                  </td>
                  <td className="py-2 text-xs text-[var(--text-muted)]">
                    {SOURCE_NOTES[t]?.status}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="mt-10">
        <h2 className="text-lg font-semibold tracking-tight">What is not connected yet</h2>
        <p className="mt-2 text-sm text-[var(--text-secondary)]">
          No live Indian property feed is connected. The repository port, the evidence model, the
          provenance rules and the production adapter contract are all built and typed, so
          connecting a real source is an adapter implementation rather than a rewrite. Until then,
          every screen that renders fixture data says so in a banner you cannot miss.
        </p>
      </section>
    </div>
  );
}
