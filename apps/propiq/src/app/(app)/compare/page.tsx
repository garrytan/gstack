import type { Metadata } from 'next';
import Link from 'next/link';
import { Check, Minus } from 'lucide-react';
import { asId } from '@/domain/shared/types';
import type { PropertyId } from '@/domain/shared/types';
import { carpetPricePerSqFt } from '@/domain/property/types';
import { bestCommute } from '@/domain/locality/types';
import { compareProperties } from '@/domain/decision/compare';
import type { CompareCandidate } from '@/domain/decision/compare';
import { daysBetween } from '@/domain/evidence/freshness';
import { buildPropertyIntelligence } from '@/server/intelligence';
import type { PropertyIntelligence } from '@/server/intelligence';
import { DemoDataBanner } from '@/components/propiq/data-status';
import { DecisionBadge } from '@/components/propiq/decision-badge';
import { TrackView } from '@/components/propiq/track-view';
import { formatINR, formatPercent, formatPsf, formatSignedPercent } from '@/lib/utils';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Decision Room',
  description:
    'Compare properties on the dimensions that decide it: price against worth, fit, unit, developer, legal, location, investment and risk.',
  alternates: { canonical: '/compare' },
};

const MAX_CANDIDATES = 4;

const toCandidate = (intel: PropertyIntelligence, now: string): CompareCandidate => {
  const phase = intel.project?.phases[0];
  const commute = intel.locality ? bestCommute(intel.locality) : undefined;
  const pillarScores: Record<string, number | undefined> = {};
  for (const p of intel.score.pillars) pillarScores[p.pillar] = p.score;

  return {
    id: intel.property.id,
    label: intel.project?.name ?? intel.property.title,
    askingPrice: intel.property.askingPrice,
    carpetPricePerSqFt: carpetPricePerSqFt(intel.property),
    score: intel.score.score,
    pillarScores,
    riskSeverity: intel.risk.coverage > 0 ? intel.risk.compositeSeverity : undefined,
    peakCommuteMinutes: commute?.peakCommuteMinutes,
    possessionMonths: phase?.currentPossession
      ? Math.max(0, daysBetween(now, phase.currentPossession) / 30.44)
      : undefined,
    grossYieldPercent: intel.investment.base.assumptions.monthlyRent
      ? intel.investment.base.grossYieldPercent
      : undefined,
    fairValueDeviationPercent: intel.valuation.insufficientEvidence
      ? undefined
      : intel.valuation.askingDeviationPercent,
  };
};

export default async function ComparePage({
  searchParams,
}: {
  searchParams: Promise<{ ids?: string }>;
}) {
  const { ids } = await searchParams;
  const requested = (ids ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => /^[a-zA-Z0-9_-]+$/.test(s))
    .slice(0, MAX_CANDIDATES);

  const now = new Date().toISOString();
  const loaded = await Promise.all(
    requested.map((id) => buildPropertyIntelligence(asId<PropertyId>(id), { now })),
  );
  const intel = loaded.filter((x): x is PropertyIntelligence => x !== undefined);

  if (intel.length === 0) return <EmptyRoom />;

  const comparison = compareProperties(
    intel.map((i) => toCandidate(i, now)),
    now,
  );
  const usesDemo = intel.some((i) => i.usesDemoData);

  return (
    <div className="mx-auto max-w-7xl px-4 py-6">
      <TrackView
        event="compare_created"
        properties={{ count: intel.length, ids: requested.join(',') }}
      />

      {usesDemo && <DemoDataBanner className="mb-6" />}

      <h1 className="text-2xl font-semibold tracking-tight">Decision Room</h1>
      <p className="mt-1 max-w-2xl text-sm text-[var(--text-secondary)]">
        {intel.length} propert{intel.length === 1 ? 'y' : 'ies'} side by side. We lead with what
        actually separates them, then name a winner per dimension where the gap is material enough
        to call.
      </p>

      {/* ---------------- Biggest differences ---------------- */}
      {comparison.biggestDifferences.length > 0 && (
        <section className="mt-6">
          <h2 className="text-xs font-semibold uppercase tracking-[0.2em] text-[var(--text-muted)]">
            Biggest differences
          </h2>
          <ul className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {comparison.biggestDifferences.map((d) => (
              <li
                key={d.label}
                className="rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-1)] p-3"
              >
                <p className="text-[10px] uppercase tracking-wide text-[var(--text-accent)]">
                  {d.label}
                </p>
                <p className="mt-1 text-xs leading-snug text-[var(--text-secondary)]">{d.detail}</p>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* ---------------- Trade-offs ---------------- */}
      {comparison.tradeOffs.length > 0 && (
        <section className="mt-5 rounded-lg border border-accent-600/40 bg-accent-600/10 p-4">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-[var(--text-accent)]">
            What the extra money buys
          </h2>
          {comparison.tradeOffs.map((t) => (
            <p key={t} className="mt-1.5 text-sm text-[var(--text-primary)]">
              {t}
            </p>
          ))}
        </section>
      )}

      {/* ---------------- Dimension winners ---------------- */}
      <section className="mt-8">
        <h2 className="text-xs font-semibold uppercase tracking-[0.2em] text-[var(--text-muted)]">
          Who wins each dimension
        </h2>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[640px] border-collapse text-sm">
            <caption className="sr-only">Winner by comparison dimension</caption>
            <thead>
              <tr className="border-b border-[var(--border-strong)] text-left">
                <th scope="col" className="py-2 pr-4 text-xs font-semibold">
                  Dimension
                </th>
                <th scope="col" className="py-2 pr-4 text-xs font-semibold">
                  Winner
                </th>
                <th scope="col" className="py-2 text-xs font-semibold">
                  Why
                </th>
              </tr>
            </thead>
            <tbody>
              {comparison.verdicts.map((v) => {
                const winner = intel.find((i) => i.property.id === v.winnerId);
                return (
                  <tr key={v.dimension} className="border-b border-[var(--border-subtle)]">
                    <th scope="row" className="py-2 pr-4 text-left text-xs font-medium">
                      {v.label}
                    </th>
                    <td className="py-2 pr-4 text-xs">
                      {winner ? (
                        <span className="inline-flex items-center gap-1.5 font-semibold text-[var(--color-buy)]">
                          <Check aria-hidden className="size-3.5" />
                          {winner.project?.name ?? winner.property.title}
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1.5 text-[var(--text-muted)]">
                          <Minus aria-hidden className="size-3.5" />
                          {v.undecidable ? 'Not comparable' : 'Too close'}
                        </span>
                      )}
                    </td>
                    <td className="py-2 text-xs text-[var(--text-secondary)]">{v.reason}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      {/* ---------------- Full comparison grid ---------------- */}
      <section className="mt-8">
        <h2 className="text-xs font-semibold uppercase tracking-[0.2em] text-[var(--text-muted)]">
          Side by side
        </h2>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[720px] border-collapse text-sm">
            <caption className="sr-only">Full property comparison</caption>
            <thead>
              <tr>
                <th scope="col" className="w-40 py-2 text-left text-xs font-semibold">
                  Measure
                </th>
                {intel.map((i) => (
                  <th key={i.property.id} scope="col" className="py-2 text-left align-bottom">
                    <Link
                      href={`/property/${i.property.id}`}
                      className="text-xs font-semibold hover:underline"
                    >
                      {i.property.title}
                    </Link>
                    <span className="mt-1.5 block">
                      <DecisionBadge decision={i.decision.decision} size="sm" />
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              <CompareRow
                label="PropIQ Score"
                intel={intel}
                render={(i) =>
                  i.score.score === undefined ? 'not published' : String(Math.round(i.score.score))
                }
              />
              <CompareRow
                label="Asking price"
                intel={intel}
                render={(i) => formatINR(i.property.askingPrice)}
              />
              <CompareRow
                label="Carpet ₹/sqft"
                intel={intel}
                render={(i) => {
                  const v = carpetPricePerSqFt(i.property);
                  return v ? formatPsf(v) : '—';
                }}
              />
              <CompareRow
                label="vs fair value"
                intel={intel}
                render={(i) =>
                  i.valuation.insufficientEvidence
                    ? 'unknown'
                    : formatSignedPercent(i.valuation.askingDeviationPercent)
                }
              />
              <CompareRow
                label="Carpet area"
                intel={intel}
                render={(i) => `${i.property.carpetAreaSqFt ?? '—'} sqft`}
              />
              <CompareRow
                label="Bedrooms"
                intel={intel}
                render={(i) => String(i.property.bedrooms)}
              />
              <CompareRow
                label="Floor"
                intel={intel}
                render={(i) =>
                  i.property.floor !== undefined
                    ? `${i.property.floor} of ${i.property.totalFloors ?? '—'}`
                    : '—'
                }
              />
              <CompareRow label="Facing" intel={intel} render={(i) => i.property.facing ?? '—'} />
              <CompareRow label="Locality" intel={intel} render={(i) => i.locality?.name ?? '—'} />
              <CompareRow
                label="Peak commute"
                intel={intel}
                render={(i) => {
                  const c = i.locality ? bestCommute(i.locality) : undefined;
                  return c ? `${c.peakCommuteMinutes} min` : '—';
                }}
              />
              <CompareRow
                label="Developer"
                intel={intel}
                render={(i) => i.developer?.name ?? '—'}
              />
              <CompareRow
                label="Avg. delay"
                intel={intel}
                render={(i) =>
                  i.developer?.averageDelayMonths !== undefined
                    ? `${i.developer.averageDelayMonths} months`
                    : '—'
                }
              />
              <CompareRow
                label="RERA status"
                intel={intel}
                render={(i) => i.project?.phases[0]?.rera?.status ?? 'unknown'}
              />
              <CompareRow
                label="Composite risk"
                intel={intel}
                render={(i) => (i.risk.coverage > 0 ? i.risk.compositeBand : 'unknown')}
              />
              <CompareRow
                label="Gross yield"
                intel={intel}
                render={(i) =>
                  i.investment.base.assumptions.monthlyRent
                    ? formatPercent(i.investment.base.grossYieldPercent, 2)
                    : '—'
                }
              />
              <CompareRow label="Data status" intel={intel} render={(i) => i.property.dataStatus} />
            </tbody>
          </table>
        </div>
      </section>

      <p className="mt-6 text-xs text-[var(--text-muted)]">
        A dimension is only called for one property when the gap clears a minimum meaningful spread.
        Anything closer is reported as too close to call rather than dressed up as a finding.
      </p>
    </div>
  );
}

const CompareRow = ({
  label,
  intel,
  render,
}: {
  label: string;
  intel: readonly PropertyIntelligence[];
  render: (i: PropertyIntelligence) => string;
}) => (
  <tr className="border-b border-[var(--border-subtle)]">
    <th scope="row" className="py-2 pr-4 text-left text-xs font-medium text-[var(--text-muted)]">
      {label}
    </th>
    {intel.map((i) => (
      <td key={i.property.id} data-figure className="py-2 pr-4 text-xs font-medium">
        {render(i)}
      </td>
    ))}
  </tr>
);

const EmptyRoom = () => (
  <div className="mx-auto max-w-3xl px-4 py-16 text-center">
    <h1 className="text-2xl font-semibold tracking-tight">Decision Room</h1>
    <p className="mx-auto mt-2 max-w-lg text-sm text-[var(--text-secondary)]">
      Nothing to compare yet. Add properties from search or from any property page, and this room
      will show you what actually separates them rather than a wall of matching rows.
    </p>
    <Link
      href="/search"
      className="mt-6 inline-flex h-10 items-center rounded-md bg-accent-500 px-4 text-sm font-semibold text-white hover:bg-accent-400"
    >
      Find properties to compare
    </Link>
  </div>
);
