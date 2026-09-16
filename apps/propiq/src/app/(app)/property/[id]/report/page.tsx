import { notFound } from 'next/navigation';
import { cache } from 'react';
import Link from 'next/link';
import type { Metadata } from 'next';
import { asId } from '@/domain/shared/types';
import type { PropertyId } from '@/domain/shared/types';
import { carpetEfficiency, carpetPricePerSqFt, pricePerSqFt } from '@/domain/property/types';
import { bestCommute } from '@/domain/locality/types';
import { DECISION_DESCRIPTIONS } from '@/domain/decision/engine';
import { buildPropertyIntelligence } from '@/server/intelligence';
import { TrackView } from '@/components/propiq/track-view';
import { PrintButton } from '@/components/propiq/print-button';
import { formatDate, formatINR, formatPercent, formatPsf, formatSignedPercent } from '@/lib/utils';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };

const loadIntelligence = cache(async (id: string) =>
  buildPropertyIntelligence(asId<PropertyId>(id)),
);

export const generateMetadata = async ({ params }: Params): Promise<Metadata> => {
  const { id } = await params;
  const intel = await loadIntelligence(id);
  if (!intel) notFound();
  return {
    title: `Intelligence report — ${intel.property.title}`,
    // A report is a frozen artefact for one buyer, not an indexable page.
    robots: { index: false, follow: false },
  };
};

/**
 * Printable intelligence report.
 *
 * A frozen, self-contained statement of what PropIQ knew at a moment in time,
 * carrying the scoring and methodology versions so the same conclusion can be
 * re-derived later. Print styles are inline because this is the only route
 * that has any, and they should not ship in the global stylesheet.
 */
export default async function ReportPage({ params }: Params) {
  const { id } = await params;
  const intel = await loadIntelligence(id);
  if (!intel) notFound();

  const { property, project, developer, locality, score, decision, risk, valuation, freshness } =
    intel;
  const phase = project?.phases[0];
  const commute = locality ? bestCommute(locality) : undefined;

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 print:max-w-none print:px-0 print:py-0">
      <TrackView
        event="report_generated"
        properties={{ propertyId: property.id, decision: decision.decision }}
      />
      <style>{`
        @media print {
          header, footer, nav { display: none !important; }
          @page { margin: 16mm; }
          a { text-decoration: none; color: inherit; }
          .page-break { break-before: page; }
        }
      `}</style>

      <div className="mb-6 flex items-center justify-between gap-4 print:hidden">
        <Link
          href={`/property/${property.id}`}
          className="text-sm text-[var(--text-accent)] hover:underline"
        >
          ← Back to the property
        </Link>
        <PrintButton />
      </div>

      {intel.usesDemoData && (
        <p className="mb-6 rounded border-2 border-[var(--color-negotiate)] p-3 text-sm font-semibold text-[var(--color-negotiate)]">
          DEMO DATA — every figure in this report is a development fixture and describes no real
          property.
        </p>
      )}

      <header className="border-b-2 border-[var(--border-strong)] pb-4">
        <p className="text-[10px] uppercase tracking-[0.2em] text-[var(--text-muted)]">
          PropIQ by CiteRank AI · Property intelligence report
        </p>
        <h1 className="mt-2 text-2xl font-semibold">{property.title}</h1>
        <p className="mt-1 text-sm text-[var(--text-secondary)]">
          {project?.name ?? 'Project'} · {locality?.name ?? 'Bengaluru'}
        </p>
        <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-2 text-xs sm:grid-cols-4">
          <Field label="Report generated" value={formatDate(intel.computedAt)} />
          <Field label="Scoring version" value={`v${score.scoringVersion}`} />
          <Field label="Decision rules" value={`v${decision.rulesVersion}`} />
          <Field label="Valuation method" value={`v${valuation.methodologyVersion}`} />
        </dl>
      </header>

      <Section title="Verdict">
        <p className="text-lg font-semibold">
          {decision.decision.replace('_', ' ')}
          {score.score !== undefined && (
            <span className="ml-3 text-base font-normal text-[var(--text-secondary)]">
              PropIQ Score {Math.round(score.score)}
              {score.band && ` (95% band ${score.band.low}–${score.band.high})`}
            </span>
          )}
        </p>
        <p className="mt-2 text-sm">{decision.headline}</p>
        <p className="mt-1 text-xs text-[var(--text-muted)]">
          {DECISION_DESCRIPTIONS[decision.decision]} Produced by rule{' '}
          <span className="font-mono">{decision.decidingRule}</span> at{' '}
          {Math.round(decision.confidence * 100)}% verdict confidence, on evidence with{' '}
          {Math.round(score.coverage * 100)}% coverage.
        </p>
      </Section>

      <Section title="What supports and works against it">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <FactorColumn title="Supports" factors={decision.positives} empty="Nothing decisive." />
          <FactorColumn title="Against" factors={decision.negatives} empty="Nothing decisive." />
          <FactorColumn title="Unknown" factors={decision.unknowns} empty="No material gaps." />
        </div>
      </Section>

      <Section title="Price and value">
        {valuation.insufficientEvidence ? (
          <p className="text-sm text-[var(--text-secondary)]">
            {valuation.adjustmentNotes[0]} Asking price is {formatINR(property.askingPrice)}.
          </p>
        ) : (
          <>
            <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-xs sm:grid-cols-4">
              <Field label="Asking price" value={formatINR(property.askingPrice)} />
              <Field label="Fair value (central)" value={formatINR(valuation.mid)} />
              <Field
                label="Fair value range"
                value={`${formatINR(valuation.low)} – ${formatINR(valuation.high)}`}
              />
              <Field
                label="Deviation"
                value={formatSignedPercent(valuation.askingDeviationPercent)}
              />
              <Field label="Quoted ₹/sqft" value={formatPsf(pricePerSqFt(property))} />
              <Field
                label="Carpet ₹/sqft"
                value={(() => {
                  const v = carpetPricePerSqFt(property);
                  return v ? formatPsf(v) : 'unknown';
                })()}
              />
              <Field
                label="Carpet efficiency"
                value={(() => {
                  const e = carpetEfficiency(property);
                  return e ? formatPercent(e * 100) : 'unknown';
                })()}
              />
              <Field
                label="Valuation confidence"
                value={`${Math.round(valuation.confidence * 100)}%`}
              />
            </dl>
            {intel.negotiation && (
              <p className="mt-3 text-sm">
                <strong>Negotiation:</strong> open at {formatINR(intel.negotiation.openingOffer)},
                target {formatINR(intel.negotiation.targetPrice)}, walk away above{' '}
                {formatINR(intel.negotiation.walkAwayPrice)}.
              </p>
            )}
          </>
        )}
      </Section>

      <Section title="Score breakdown">
        <table className="w-full border-collapse text-xs">
          <caption className="sr-only">Pillar scores with coverage</caption>
          <thead>
            <tr className="border-b border-[var(--border-strong)] text-left">
              <th scope="col" className="py-1.5 font-semibold">
                Pillar
              </th>
              <th scope="col" className="py-1.5 text-right font-semibold">
                Score
              </th>
              <th scope="col" className="py-1.5 text-right font-semibold">
                Coverage
              </th>
              <th scope="col" className="py-1.5 text-right font-semibold">
                Weight
              </th>
            </tr>
          </thead>
          <tbody>
            {score.pillars.map((p) => (
              <tr key={p.pillar} className="border-b border-[var(--border-subtle)]">
                <th scope="row" className="py-1.5 text-left font-medium">
                  {p.label}
                </th>
                <td data-figure className="py-1.5 text-right">
                  {p.score === undefined ? 'no evidence' : Math.round(p.score)}
                </td>
                <td data-figure className="py-1.5 text-right">
                  {Math.round(p.coverage * 100)}%
                </td>
                <td data-figure className="py-1.5 text-right text-[var(--text-muted)]">
                  {Math.round((score.weights[p.pillar] ?? 0) * 100)}%
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {score.notes.length > 0 && (
          <ul className="mt-2 space-y-0.5">
            {score.notes.map((n) => (
              <li key={n} className="text-[11px] text-[var(--text-muted)]">
                {n}
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Risk" className="page-break">
        <table className="w-full border-collapse text-xs">
          <caption className="sr-only">Risk dimensions with drivers</caption>
          <thead>
            <tr className="border-b border-[var(--border-strong)] text-left">
              <th scope="col" className="py-1.5 font-semibold">
                Dimension
              </th>
              <th scope="col" className="py-1.5 font-semibold">
                Band
              </th>
              <th scope="col" className="py-1.5 font-semibold">
                Why
              </th>
            </tr>
          </thead>
          <tbody>
            {risk.dimensions.map((d) => (
              <tr key={d.dimension} className="border-b border-[var(--border-subtle)] align-top">
                <th scope="row" className="py-1.5 pr-3 text-left font-medium">
                  {d.label}
                </th>
                <td className="py-1.5 pr-3 capitalize">{d.band}</td>
                <td className="py-1.5 text-[var(--text-secondary)]">{d.drivers.join(' ')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      <Section title="Legal, developer and locality">
        <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-xs sm:grid-cols-3">
          <Field label="RERA status" value={phase?.rera?.status ?? 'unknown'} />
          <Field label="RERA number" value={phase?.rera?.number || 'not issued'} />
          <Field label="RERA valid until" value={formatDate(phase?.rera?.validUntil)} />
          <Field label="Construction status" value={property.constructionStatus} />
          <Field label="Promised possession" value={formatDate(phase?.promisedPossession)} />
          <Field label="Current possession" value={formatDate(phase?.currentPossession)} />
          <Field label="Developer" value={developer?.name ?? 'unknown'} />
          <Field
            label="Average delay"
            value={
              developer?.averageDelayMonths !== undefined
                ? `${developer.averageDelayMonths} months`
                : 'unknown'
            }
          />
          <Field
            label="Units delivered"
            value={developer?.unitsDelivered?.toLocaleString('en-IN') ?? 'unknown'}
          />
          <Field label="Locality" value={locality?.name ?? 'unknown'} />
          <Field
            label="Peak commute"
            value={commute ? `${commute.peakCommuteMinutes} min to ${commute.hubName}` : 'unknown'}
          />
          <Field
            label="Locality median"
            value={
              locality?.currentMedianPricePerSqFt
                ? formatPsf(locality.currentMedianPricePerSqFt)
                : 'unknown'
            }
          />
        </dl>
      </Section>

      <Section title="Evidence and disclosure">
        <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-xs sm:grid-cols-4">
          <Field label="Evidence records" value={String(freshness.totalCount)} />
          <Field
            label="Stale records"
            value={`${freshness.staleCount} (${freshness.stalePercentage}%)`}
          />
          <Field label="Newest observation" value={`${freshness.newestObservationDays} days old`} />
          <Field label="Oldest observation" value={`${freshness.oldestObservationDays} days old`} />
          <Field
            label="Developer relationship"
            value={property.commercial.developerRelationship ? 'Yes' : 'No'}
          />
          <Field label="Paid placement" value={property.commercial.paidPlacement ? 'Yes' : 'No'} />
          <Field
            label="Commission possible"
            value={property.commercial.commissionPossible ? 'Yes' : 'No'}
          />
          <Field label="Data status" value={property.dataStatus} />
        </dl>
        <p className="mt-3 text-[11px] text-[var(--text-muted)]">
          No commercial arrangement affects the PropIQ Score. Scoring inputs and commercial fields
          are computed in separate systems that do not read each other. The full evidence list, with
          a source and a date per fact, is on the property page.
        </p>
      </Section>

      <footer className="mt-8 border-t border-[var(--border-subtle)] pt-4 text-[11px] text-[var(--text-muted)]">
        <p>
          PropIQ produces decision support, not investment, legal or tax advice. Every estimate in
          this report carries a confidence and a source. This report reflects the evidence held on{' '}
          {formatDate(intel.computedAt)} under scoring v{score.scoringVersion}; re-running it later
          may produce a different result as evidence changes.
        </p>
      </footer>
    </div>
  );
}

const Section = ({
  title,
  className,
  children,
}: {
  title: string;
  className?: string;
  children: React.ReactNode;
}) => (
  <section className={`mt-6 ${className ?? ''}`}>
    <h2 className="border-b border-[var(--border-subtle)] pb-1 text-sm font-semibold uppercase tracking-wide">
      {title}
    </h2>
    <div className="mt-3">{children}</div>
  </section>
);

const Field = ({ label, value }: { label: string; value: string }) => (
  <div>
    <dt className="text-[10px] uppercase tracking-wide text-[var(--text-muted)]">{label}</dt>
    <dd data-figure className="font-medium">
      {value}
    </dd>
  </div>
);

const FactorColumn = ({
  title,
  factors,
  empty,
}: {
  title: string;
  factors: ReadonlyArray<{ label: string; detail: string; rule: string }>;
  empty: string;
}) => (
  <div>
    <h3 className="text-[10px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">
      {title}
    </h3>
    {factors.length === 0 ? (
      <p className="mt-1 text-xs text-[var(--text-muted)]">{empty}</p>
    ) : (
      <ul className="mt-1 space-y-1">
        {factors.map((f) => (
          <li key={`${f.rule}-${f.label}`} className="text-xs">
            <span className="font-medium">{f.label}</span>{' '}
            <span className="text-[var(--text-secondary)]">{f.detail}</span>
          </li>
        ))}
      </ul>
    )}
  </div>
);
