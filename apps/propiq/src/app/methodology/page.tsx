import type { Metadata } from 'next';
import { CURRENT_SCORING_VERSION, SCORING_VERSIONS } from '@/domain/scoring/weights';
import { SCORE_PILLARS, PILLAR_LABELS } from '@/domain/scoring/types';
import { BUYER_PERSONAS } from '@/domain/buyer/types';
import { DECISION_THRESHOLDS, DECISION_DESCRIPTIONS, DECISIONS } from '@/domain/decision/engine';
import { RISK_DIMENSIONS, RISK_LABELS } from '@/domain/risk/types';
import { SOURCE_HALF_LIFE_DAYS, STALE_AFTER_DAYS } from '@/domain/evidence/freshness';
import { MIN_COMPARABLES, VALUATION_METHODOLOGY_VERSION } from '@/domain/valuation/engine';

export const metadata: Metadata = {
  title: 'Methodology',
  description:
    'The published PropIQ methodology: pillar weights, normalisation, confidence bands, decision thresholds and evidence decay. No black-box scoring.',
  alternates: { canonical: '/methodology' },
};

/**
 * This page reads the live constants out of the domain layer rather than
 * restating them in prose. A weight change therefore updates the published
 * methodology automatically, and the two can never drift apart.
 */
export default function MethodologyPage() {
  const v = CURRENT_SCORING_VERSION;

  return (
    <div className="mx-auto max-w-4xl px-4 py-10">
      <h1 className="text-3xl font-semibold tracking-tight">Methodology</h1>
      <p className="mt-3 text-base text-[var(--text-secondary)]">
        PropIQ publishes its scoring formula, its weights and its thresholds. Everything on this
        page is read directly from the running code, so it cannot drift from what actually produced
        your score.
      </p>

      <Section title="The pipeline">
        <p>
          Structured evidence becomes normalised signals, signals become pillar scores, and pillar
          scores become one composite weighted for who you are. At no point does a language model
          produce a number. Every step is arithmetic you can check.
        </p>
        <ol className="mt-3 list-decimal space-y-1 pl-5">
          <li>Evidence records are collected, each with a source, a date and a confidence.</li>
          <li>
            Confidence decays against the source&rsquo;s half-life, so old facts count for less.
          </li>
          <li>Raw values are normalised to 0–1 by published functions.</li>
          <li>
            Signals are weighted within their pillar; missing signals are dropped and the rest
            rescaled.
          </li>
          <li>Pillars are weighted by buyer persona into a 0–100 composite.</li>
          <li>Deterministic rules turn the composite, risks and price into a verdict.</li>
        </ol>
      </Section>

      <Section title={`Pillar weights — scoring v${v.version}`}>
        <p>{v.summary}</p>
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[520px] border-collapse text-sm">
            <caption className="sr-only">Pillar weights by buyer persona</caption>
            <thead>
              <tr className="border-b border-[var(--border-strong)] text-left text-xs">
                <th scope="col" className="py-2 pr-4 font-semibold">
                  Pillar
                </th>
                {BUYER_PERSONAS.map((p) => (
                  <th key={p} scope="col" className="py-2 pr-4 text-right font-semibold capitalize">
                    {p === 'nri' ? 'NRI' : p}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {SCORE_PILLARS.map((pillar) => (
                <tr key={pillar} className="border-b border-[var(--border-subtle)]">
                  <th scope="row" className="py-1.5 pr-4 text-left text-xs font-medium">
                    {PILLAR_LABELS[pillar]}
                  </th>
                  {BUYER_PERSONAS.map((persona) => (
                    <td key={persona} data-figure className="py-1.5 pr-4 text-right text-xs">
                      {(v.weights[persona][pillar] * 100).toFixed(0)}%
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <Section title="Missing data">
        <p>
          A signal we cannot measure is not scored as zero. It is dropped, and the remaining weights
          within that pillar are rescaled so the score reflects only what we actually know. The
          share of weight that survived is reported as <strong>coverage</strong>.
        </p>
        <p className="mt-2">
          Below <strong>{Math.round(v.minimumCoverage * 100)}% coverage</strong> or{' '}
          <strong>{Math.round(v.minimumConfidence * 100)}% confidence</strong>, PropIQ publishes no
          score at all and the verdict becomes <em>insufficient evidence</em>. We would rather tell
          you we do not know.
        </p>
      </Section>

      <Section title="Confidence bands">
        <p>
          Every published score carries a 95% band. The band widens as coverage and confidence fall:
          it runs from about ±2 points on a complete, well-verified record to ±18 points at the
          reporting floor. The band describes uncertainty in the evidence, not sampling noise.
        </p>
      </Section>

      <Section title="Evidence decay">
        <p>
          A fact is only as good as its age, and different facts age at very different rates. A RERA
          registration stays informative for years; an asking price is stale in weeks. Confidence
          decays as{' '}
          <code className="font-mono text-xs">confidence × trust × 0.5^(age / half-life)</code>.
        </p>
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[420px] border-collapse text-sm">
            <caption className="sr-only">Evidence half-life and staleness by source type</caption>
            <thead>
              <tr className="border-b border-[var(--border-strong)] text-left text-xs">
                <th scope="col" className="py-2 pr-4 font-semibold">
                  Source type
                </th>
                <th scope="col" className="py-2 pr-4 text-right font-semibold">
                  Half-life
                </th>
                <th scope="col" className="py-2 text-right font-semibold">
                  Stale after
                </th>
              </tr>
            </thead>
            <tbody>
              {Object.keys(SOURCE_HALF_LIFE_DAYS).map((key) => {
                const k = key as keyof typeof SOURCE_HALF_LIFE_DAYS;
                return (
                  <tr key={key} className="border-b border-[var(--border-subtle)]">
                    <th scope="row" className="py-1.5 pr-4 text-left text-xs font-medium">
                      {key}
                    </th>
                    <td data-figure className="py-1.5 pr-4 text-right text-xs">
                      {SOURCE_HALF_LIFE_DAYS[k]} days
                    </td>
                    <td data-figure className="py-1.5 text-right text-xs">
                      {STALE_AFTER_DAYS[k]} days
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Section>

      <Section title={`Fair value — valuation v${VALUATION_METHODOLOGY_VERSION}`}>
        <p>
          Comparables are adjusted onto the subject&rsquo;s terms for time,
          listing-versus-transaction, floor, age and size, then weighted by recency, proximity, size
          similarity and whether money actually changed hands. The central estimate is the weighted
          mean; the band comes from the weighted dispersion, widened when the comparable set is
          thin.
        </p>
        <p className="mt-2">
          With fewer than <strong>{MIN_COMPARABLES}</strong> usable comparables we publish no value.
          A fabricated central estimate is worse than an honest blank.
        </p>
      </Section>

      <Section title="Risk">
        <p>
          Risk is reported as {RISK_DIMENSIONS.length} named dimensions, each with its own severity,
          its own band and its own drivers. There is no single red-or-green badge, because
          &ldquo;medium risk&rdquo; tells you nothing you can act on.
        </p>
        <ul className="mt-3 grid grid-cols-1 gap-1 sm:grid-cols-2">
          {RISK_DIMENSIONS.map((d) => (
            <li key={d} className="text-sm text-[var(--text-secondary)]">
              • {RISK_LABELS[d]}
            </li>
          ))}
        </ul>
      </Section>

      <Section title="Decision rules">
        <p>
          The verdict is a deterministic function of the score, the risk profile and the price
          against fair value. Rules are evaluated top down: the evidence gate, then disqualifying
          risks, then the price gate, then the score bands.
        </p>
        <dl className="mt-4 space-y-2">
          {DECISIONS.map((d) => (
            <div
              key={d}
              className="rounded-md border border-[var(--border-subtle)] bg-[var(--surface-1)] p-3"
            >
              <dt className="text-sm font-semibold">{d.replace('_', ' ')}</dt>
              <dd className="mt-0.5 text-xs text-[var(--text-secondary)]">
                {DECISION_DESCRIPTIONS[d]}
              </dd>
            </div>
          ))}
        </dl>
        <table className="mt-4 w-full border-collapse text-sm">
          <caption className="sr-only">Published decision thresholds</caption>
          <tbody>
            <ThresholdRow label="Buy at or above" value={`${DECISION_THRESHOLDS.buyScore} / 100`} />
            <ThresholdRow
              label="Watch at or above"
              value={`${DECISION_THRESHOLDS.watchScore} / 100`}
            />
            <ThresholdRow
              label="Negotiate when asking exceeds fair value by"
              value={`${DECISION_THRESHOLDS.negotiateDeviationPercent}%`}
            />
            <ThresholdRow
              label="A single risk is disqualifying at severity"
              value={String(DECISION_THRESHOLDS.fatalRiskSeverity)}
            />
            <ThresholdRow
              label="Composite risk caps the verdict at Watch from"
              value={String(DECISION_THRESHOLDS.heavyRiskSeverity)}
            />
            <ThresholdRow
              label="Minimum verdict confidence"
              value={String(DECISION_THRESHOLDS.minVerdictConfidence)}
            />
          </tbody>
        </table>
      </Section>

      <Section title="What never touches the score">
        <p>
          Commercial relationships — developer agreements, paid placement, commission — are
          disclosed on every property and are computed in a system the scoring engine does not read.
          There is no code path by which a commercial field can change an organic score.
        </p>
      </Section>

      <Section title="Versions">
        <p>
          Weights and thresholds are versioned. A change means a new version, never an edit to an
          existing one, so a score computed months ago can still be re-explained under the rules it
          was produced by.
        </p>
        <ul className="mt-2 space-y-1">
          {SCORING_VERSIONS.map((sv) => (
            <li key={sv.version} className="text-sm text-[var(--text-secondary)]">
              <strong>v{sv.version}</strong>, effective {sv.effectiveFrom}
            </li>
          ))}
        </ul>
      </Section>
    </div>
  );
}

const Section = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <section className="mt-10">
    <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
    <div className="mt-2 space-y-2 text-sm leading-relaxed text-[var(--text-secondary)]">
      {children}
    </div>
  </section>
);

const ThresholdRow = ({ label, value }: { label: string; value: string }) => (
  <tr className="border-b border-[var(--border-subtle)]">
    <th scope="row" className="py-1.5 pr-4 text-left text-xs font-medium">
      {label}
    </th>
    <td data-figure className="py-1.5 text-right text-xs font-semibold">
      {value}
    </td>
  </tr>
);
