import { notFound } from 'next/navigation';
import { cache } from 'react';
import Link from 'next/link';
import type { Metadata } from 'next';
import { Building2, CalendarClock, MapPin, Ruler, ScrollText } from 'lucide-react';
import { asId } from '@/domain/shared/types';
import type { PropertyId } from '@/domain/shared/types';
import { carpetEfficiency, pricePerSqFt } from '@/domain/property/types';
import { bestCommute } from '@/domain/locality/types';
import { buildPropertyIntelligence } from '@/server/intelligence';
import { isWatched, loadBuyerProfile, loadVisits } from '@/server/actions';
import { visitToEvidence } from '@/domain/visits/engine';
import { DemoDataBanner, DataStatusBadge } from '@/components/propiq/data-status';
import { DecisionBadge } from '@/components/propiq/decision-badge';
import { ScoreDial } from '@/components/propiq/score-dial';
import { PillarBars } from '@/components/propiq/pillar-bars';
import { RiskGrid } from '@/components/propiq/risk-grid';
import { ValuationBand } from '@/components/propiq/valuation-band';
import { EvidencePanel } from '@/components/propiq/evidence-panel';
import { InvestmentPanel } from '@/components/propiq/investment-panel';
import { WatchlistButton } from '@/components/propiq/watchlist-button';
import { PropertyCard } from '@/components/propiq/property-card';
import { TrackView } from '@/components/propiq/track-view';
import { buildSummaries } from '@/server/intelligence';
import { DECISION_DESCRIPTIONS } from '@/domain/decision/engine';
import { formatDate, formatINR, formatPercent, formatPsf, formatRelative } from '@/lib/utils';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };

/**
 * Deduped per-request loader.
 *
 * `generateMetadata` and the page body both need the payload. React `cache`
 * collapses them into a single computation per request, so the scoring chain
 * runs once rather than twice.
 */
const loadIntelligence = cache(async (id: string) => {
  // The saved profile drives persona weighting and every buyer-fit signal, and
  // a completed site visit contributes first-party evidence. Both are read here
  // so the verdict on this page is the one for this buyer, on what they have
  // actually seen — not for an average buyer on second-hand data.
  const now = new Date().toISOString();
  const [buyer, visits] = await Promise.all([loadBuyerProfile(), loadVisits(id)]);
  const visitEvidence = visits
    .filter((v) => v.status === 'completed')
    .flatMap((v) => visitToEvidence(v, now));

  return buildPropertyIntelligence(asId<PropertyId>(id), {
    now,
    buyer,
    persona: buyer?.persona,
    visitEvidence,
  });
});

export const generateMetadata = async ({ params }: Params): Promise<Metadata> => {
  const { id } = await params;
  // notFound() is raised here rather than in the page body: this route is
  // force-dynamic, so by the time the body renders the 200 status has already
  // been committed to the stream and the not-found page would be served as a
  // soft 404. generateMetadata runs before the stream opens.
  const intel = await loadIntelligence(id);
  if (!intel) notFound();
  const verdict = intel.decision.decision.replace('_', ' ').toLowerCase();
  return {
    title: `${intel.property.title} — PropIQ verdict: ${verdict}`,
    description:
      `${intel.property.title} in ${intel.locality?.name ?? 'Bengaluru'}. ` +
      `PropIQ Score ${intel.score.score ?? 'not published'}, asking ${formatINR(intel.property.askingPrice)}. ` +
      `${intel.decision.headline}`,
    alternates: { canonical: `/property/${id}` },
  };
};

export default async function PropertyPage({ params }: Params) {
  const { id } = await params;
  const intel = await loadIntelligence(id);
  if (!intel) notFound();

  const { property, project, developer, locality, score, decision, risk, valuation, freshness } =
    intel;
  const phase = project?.phases[0];
  const watched = await isWatched(property.id);
  const alternatives = await buildSummaries(intel.alternatives);
  const commute = locality ? bestCommute(locality) : undefined;
  const efficiency = carpetEfficiency(property);

  return (
    <div className="mx-auto max-w-7xl px-4 py-6">
      <TrackView
        event="property_viewed"
        properties={{
          propertyId: property.id,
          decision: decision.decision,
          score: score.score ?? -1,
          demo: intel.usesDemoData,
        }}
      />

      {intel.usesDemoData && <DemoDataBanner className="mb-6" />}

      <nav aria-label="Breadcrumb" className="mb-4 text-xs text-[var(--text-muted)]">
        <ol className="flex flex-wrap items-center gap-1.5">
          <li>
            <Link href="/" className="hover:underline">
              Home
            </Link>
          </li>
          <li aria-hidden>/</li>
          <li>
            <Link href="/search" className="hover:underline">
              Search
            </Link>
          </li>
          {locality && (
            <>
              <li aria-hidden>/</li>
              <li>
                <Link href={`/locality/${locality.slug}`} className="hover:underline">
                  {locality.name}
                </Link>
              </li>
            </>
          )}
          <li aria-hidden>/</li>
          <li aria-current="page" className="text-[var(--text-secondary)]">
            {property.title}
          </li>
        </ol>
      </nav>

      {/* ---------------- Header ---------------- */}
      <header className="rounded-lg propiq-card p-5">
        <div className="flex flex-col gap-6 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <DecisionBadge
                decision={decision.decision}
                confidence={decision.confidence}
                size="lg"
              />
              <DataStatusBadge status={property.dataStatus} />
            </div>
            <h1 className="mt-3 text-2xl font-semibold tracking-tight sm:text-3xl">
              {property.title}
            </h1>
            <p className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-[var(--text-muted)]">
              <span className="inline-flex items-center gap-1">
                <Building2 aria-hidden className="size-3.5" />
                {project?.name ?? 'Project'}
              </span>
              <span className="inline-flex items-center gap-1">
                <MapPin aria-hidden className="size-3.5" />
                {locality?.name ?? 'Bengaluru'}
              </span>
              <span className="inline-flex items-center gap-1">
                <Ruler aria-hidden className="size-3.5" />
                {property.areaSqFt} sqft super built-up
                {property.carpetAreaSqFt ? ` · ${property.carpetAreaSqFt} sqft carpet` : ''}
              </span>
            </p>

            <p className="mt-4 max-w-2xl text-base leading-relaxed">{decision.headline}</p>
            <p className="mt-1 text-xs text-[var(--text-muted)]">
              {DECISION_DESCRIPTIONS[decision.decision]} Rule{' '}
              <code className="font-mono">{decision.decidingRule}</code>, decision rules v
              {decision.rulesVersion}.
            </p>

            <dl className="mt-5 grid grid-cols-2 gap-4 sm:grid-cols-4">
              <HeaderStat label="Asking price" value={formatINR(property.askingPrice)} />
              <HeaderStat label="₹ per sqft" value={formatPsf(pricePerSqFt(property))} />
              <HeaderStat
                label="Carpet efficiency"
                value={efficiency ? formatPercent(efficiency * 100) : 'unknown'}
              />
              <HeaderStat
                label="Data freshness"
                value={`${freshness.newestObservationDays}–${freshness.oldestObservationDays} days`}
                hint={`${freshness.staleCount} of ${freshness.totalCount} records stale`}
              />
            </dl>

            <div className="mt-5 flex flex-wrap gap-2">
              <WatchlistButton propertyId={property.id} initiallyWatched={watched} />
              <Link
                href={`/compare?ids=${property.id}`}
                className="inline-flex h-10 items-center rounded-md border border-[var(--border-strong)] px-4 text-sm font-medium hover:bg-[var(--surface-2)]"
              >
                Compare
              </Link>
              <Link
                href={`/copilot?property=${property.id}`}
                className="inline-flex h-10 items-center rounded-md border border-[var(--border-strong)] px-4 text-sm font-medium hover:bg-[var(--surface-2)]"
              >
                Ask PropIQ
              </Link>
              <Link
                href={`/property/${property.id}/visit`}
                className="inline-flex h-10 items-center rounded-md border border-[var(--border-strong)] px-4 text-sm font-medium hover:bg-[var(--surface-2)]"
              >
                Site visit
              </Link>
              <Link
                href={`/property/${property.id}/negotiate`}
                className="inline-flex h-10 items-center rounded-md border border-[var(--border-strong)] px-4 text-sm font-medium hover:bg-[var(--surface-2)]"
              >
                Negotiate
              </Link>
              <Link
                href={`/property/${property.id}/report`}
                className="inline-flex h-10 items-center rounded-md border border-[var(--border-strong)] px-4 text-sm font-medium hover:bg-[var(--surface-2)]"
              >
                Report
              </Link>
            </div>
          </div>

          <div className="shrink-0 lg:pl-6">
            <ScoreDial score={score.score} band={score.band} confidence={score.confidence} />
            <p className="mt-2 max-w-[180px] text-center text-[11px] text-[var(--text-muted)]">
              Scoring v{score.scoringVersion}, weighted for a {score.persona}.{' '}
              <Link href="/preferences" className="text-[var(--text-accent)] hover:underline">
                Change this
              </Link>
            </p>
          </div>
        </div>
      </header>

      {/* ---------------- Why this verdict ---------------- */}
      <Section title="Why this verdict" id="verdict">
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <FactorList
            title="What supports it"
            tone="var(--color-buy)"
            factors={decision.positives}
            empty="Nothing in the evidence stands out as a decisive positive."
          />
          <FactorList
            title="What works against it"
            tone="var(--color-avoid)"
            factors={decision.negatives}
            empty="No decisive negatives surfaced in the evidence we hold."
          />
          <FactorList
            title="What we do not know"
            tone="var(--color-unknown)"
            factors={decision.unknowns}
            empty="No material gaps in the evidence for this property."
          />
        </div>
        {score.notes.length > 0 && (
          <ul className="mt-4 space-y-1">
            {score.notes.map((n) => (
              <li key={n} className="text-[11px] text-[var(--text-muted)]">
                {n}
              </li>
            ))}
          </ul>
        )}
      </Section>

      {/* ---------------- Fair value ---------------- */}
      <Section title="Fair value & negotiation" id="value">
        <ValuationBand valuation={valuation} negotiation={intel.negotiation} />
      </Section>

      {/* ---------------- Score breakdown ---------------- */}
      <Section
        title="Score breakdown"
        id="score"
        description="Every pillar expands into the signals behind it, the raw value we observed, and the exact normalisation applied."
      >
        <div className="rounded-lg propiq-card px-4">
          <PillarBars pillars={score.pillars} weights={score.weights} />
        </div>
      </Section>

      {/* ---------------- Risks ---------------- */}
      <Section
        title="Risks"
        id="risks"
        description={`Nine dimensions, scored separately. Coverage ${Math.round(risk.coverage * 100)}%, methodology v${risk.methodologyVersion}.`}
      >
        <RiskGrid risk={risk} />
      </Section>

      {/* ---------------- Legal / RERA ---------------- */}
      <Section title="Legal & RERA" id="legal">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <InfoCard icon={ScrollText} title="RERA registration">
            {phase?.rera ? (
              <>
                <dl className="space-y-1.5 text-xs">
                  <Row label="Status" value={phase.rera.status} />
                  <Row label="Number" value={phase.rera.number || 'not issued'} />
                  <Row label="State" value={phase.rera.state} />
                  <Row label="Valid until" value={formatDate(phase.rera.validUntil)} />
                </dl>
                {/* Outside the list: a `dl` admits only `dt`, `dd` and wrappers
                    of them, and a verification link is neither. */}
                {phase.rera.portalUrl && (
                  <a
                    href={phase.rera.portalUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-2 inline-block text-xs text-[var(--text-accent)] underline underline-offset-2"
                  >
                    Verify on the state RERA portal
                  </a>
                )}
              </>
            ) : (
              <p className="text-xs text-[var(--text-muted)]">
                No RERA record on file for this phase. That absence is itself treated as a legal
                risk, not as a neutral gap.
              </p>
            )}
          </InfoCard>

          <InfoCard icon={CalendarClock} title="Possession">
            <dl className="space-y-1.5 text-xs">
              <Row label="Construction status" value={property.constructionStatus} />
              <Row
                label="Completion"
                value={
                  phase?.completionPercent !== undefined ? `${phase.completionPercent}%` : 'unknown'
                }
              />
              <Row label="Originally promised" value={formatDate(phase?.promisedPossession)} />
              <Row label="Current commitment" value={formatDate(phase?.currentPossession)} />
              {phase?.currentPossession && (
                <Row label="That is" value={formatRelative(phase.currentPossession)} />
              )}
            </dl>
          </InfoCard>
        </div>
      </Section>

      {/* ---------------- Developer ---------------- */}
      {developer && (
        <Section title="Developer" id="developer">
          <div className="rounded-lg propiq-card p-4">
            <h3 className="text-sm font-semibold">{developer.name}</h3>
            <dl className="mt-3 grid grid-cols-2 gap-4 sm:grid-cols-5">
              <HeaderStat
                label="Incorporated"
                value={developer.incorporatedYear?.toString() ?? '—'}
              />
              <HeaderStat
                label="Projects delivered"
                value={developer.projectsDelivered?.toString() ?? '—'}
              />
              <HeaderStat
                label="Units delivered"
                value={developer.unitsDelivered?.toLocaleString('en-IN') ?? '—'}
              />
              <HeaderStat
                label="Average delay"
                value={
                  developer.averageDelayMonths !== undefined
                    ? `${developer.averageDelayMonths} months`
                    : '—'
                }
              />
              <HeaderStat
                label="RERA complaints"
                value={developer.reraComplaintsCount?.toString() ?? '—'}
              />
            </dl>
          </div>
        </Section>
      )}

      {/* ---------------- Locality ---------------- */}
      {locality && (
        <Section title="Locality & infrastructure" id="locality">
          <div className="rounded-lg propiq-card p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold">
                  <Link href={`/locality/${locality.slug}`} className="hover:underline">
                    {locality.name}
                  </Link>
                </h3>
                {locality.summary && (
                  <p className="mt-1 max-w-2xl text-xs text-[var(--text-secondary)]">
                    {locality.summary}
                  </p>
                )}
              </div>
              <DataStatusBadge status={locality.dataStatus} />
            </div>

            <dl className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-4 lg:grid-cols-6">
              <HeaderStat
                label="Median ₹/sqft"
                value={
                  locality.currentMedianPricePerSqFt
                    ? formatPsf(locality.currentMedianPricePerSqFt)
                    : '—'
                }
              />
              <HeaderStat
                label="Gross yield"
                value={formatPercent(locality.grossRentalYieldPercent)}
              />
              <HeaderStat
                label="Peak commute"
                value={commute ? `${commute.peakCommuteMinutes} min` : '—'}
                hint={commute?.hubName}
              />
              <HeaderStat
                label="Metro"
                value={
                  locality.transit.metroDistanceKm !== undefined
                    ? `${locality.transit.metroDistanceKm} km`
                    : '—'
                }
                hint={
                  locality.transit.metroEtaMonths === 0
                    ? 'operational'
                    : `${locality.transit.metroEtaMonths} months out`
                }
              />
              <HeaderStat
                label="PM2.5"
                value={
                  locality.environment.pm25Annual ? `${locality.environment.pm25Annual} µg/m³` : '—'
                }
              />
              <HeaderStat
                label="Schools within 3km"
                value={locality.social.schoolsWithin3Km?.toString() ?? '—'}
              />
            </dl>

            {locality.pipeline.length > 0 && (
              <div className="mt-4">
                <p className="text-xs font-semibold">Infrastructure pipeline</p>
                <ul className="mt-2 space-y-1">
                  {locality.pipeline.map((p) => (
                    <li key={p.name} className="text-xs text-[var(--text-secondary)]">
                      <span className="font-medium">{p.name}</span> — {p.status}
                      {p.expectedCompletion ? `, expected ${formatDate(p.expectedCompletion)}` : ''}
                    </li>
                  ))}
                </ul>
                <p className="mt-2 text-[11px] text-[var(--text-muted)]">
                  Only funded, under-construction and commissioned projects count toward the
                  infrastructure score. Announcements do not.
                </p>
              </div>
            )}
          </div>
        </Section>
      )}

      {/* ---------------- Investment ---------------- */}
      <Section title="Investment outlook" id="investment">
        <InvestmentPanel analysis={intel.investment} />
      </Section>

      {/* ---------------- Alternatives ---------------- */}
      {alternatives.length > 0 && (
        <Section
          title="Comparable alternatives"
          id="alternatives"
          description="Same bedroom count, within 30% of this asking price."
        >
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
            {alternatives.map((a) => (
              <PropertyCard key={a.property.id} intelligence={a} />
            ))}
          </div>
          <Link
            href={`/compare?ids=${[property.id, ...alternatives.map((a) => a.property.id)].join(',')}`}
            className="mt-4 inline-flex h-10 items-center rounded-md bg-accent-500 px-4 text-sm font-semibold text-white hover:bg-accent-400"
          >
            Open all in the Decision Room
          </Link>
        </Section>
      )}

      {/* ---------------- Evidence ---------------- */}
      <Section title="Evidence & sources" id="evidence">
        {intel.visitEvidenceCount > 0 && (
          <p className="mb-3 text-xs text-[var(--text-secondary)]">
            {intel.visitEvidenceCount} of these records came from your own site visit. First-party
            observations are the only evidence here that is not second-hand, and they are weighted
            accordingly.
          </p>
        )}
        <EvidencePanel
          evidence={property.evidence}
          commercial={property.commercial}
          title="Every fact behind this page"
        />
      </Section>
    </div>
  );
}

// ---------------------------------------------------------------------------

const Section = ({
  title,
  id,
  description,
  children,
}: {
  title: string;
  id: string;
  description?: string;
  children: React.ReactNode;
}) => (
  <section id={id} className="mt-8 scroll-mt-20">
    <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
    {description && <p className="mt-1 text-xs text-[var(--text-muted)]">{description}</p>}
    <div className="mt-3">{children}</div>
  </section>
);

// Only `dt` and `dd` may sit inside a `dl`'s wrapper div, so the hint rides
// inside the `dd` rather than as a sibling paragraph.
const HeaderStat = ({ label, value, hint }: { label: string; value: string; hint?: string }) => (
  <div>
    <dt className="text-[10px] uppercase tracking-wide text-[var(--text-muted)]">{label}</dt>
    <dd className="mt-0.5">
      <span data-figure className="block text-sm font-semibold">
        {value}
      </span>
      {hint && <span className="block text-[10px] text-[var(--text-muted)]">{hint}</span>}
    </dd>
  </div>
);

const Row = ({ label, value }: { label: string; value: string }) => (
  <div className="flex justify-between gap-3">
    <dt className="text-[var(--text-muted)]">{label}</dt>
    <dd data-figure className="text-right font-medium">
      {value}
    </dd>
  </div>
);

const InfoCard = ({
  icon: Icon,
  title,
  children,
}: {
  icon: typeof ScrollText;
  title: string;
  children: React.ReactNode;
}) => (
  <div className="rounded-lg propiq-card p-4">
    <h3 className="flex items-center gap-2 text-sm font-semibold">
      <Icon aria-hidden className="size-4 text-[var(--text-accent)]" />
      {title}
    </h3>
    <div className="mt-3">{children}</div>
  </div>
);

const FactorList = ({
  title,
  tone,
  factors,
  empty,
}: {
  title: string;
  tone: string;
  factors: ReadonlyArray<{ label: string; detail: string; rule: string }>;
  empty: string;
}) => (
  <div className="rounded-lg propiq-card p-4">
    <h3 className="text-xs font-semibold uppercase tracking-wide" style={{ color: tone }}>
      {title}
    </h3>
    {factors.length === 0 ? (
      <p className="mt-2 text-xs text-[var(--text-muted)]">{empty}</p>
    ) : (
      <ul className="mt-2 space-y-2">
        {factors.map((f) => (
          <li key={`${f.rule}-${f.label}`}>
            <p className="text-xs font-medium">{f.label}</p>
            <p className="text-[11px] text-[var(--text-secondary)]">{f.detail}</p>
          </li>
        ))}
      </ul>
    )}
  </div>
);
