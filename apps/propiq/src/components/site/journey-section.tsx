/**
 * The buyer journey.
 *
 * The product's spine — Discover through Monitor — laid out as the flow it
 * actually is, with the surface that serves each stage linked from it.
 *
 * Two rules hold this section honest:
 *
 *  1. Every figure is the `.length` of a live domain constant, computed here
 *     rather than typed, so a stage cannot advertise more than the engine
 *     behind it does.
 *  2. A stage with no route does not get a link. `Buy` is not built, and it
 *     says so plainly rather than pointing at the nearest page that exists —
 *     a flow diagram that quietly implies coverage it does not have is the
 *     same failure as a fabricated figure, drawn instead of written.
 */

import Link from 'next/link';
import { ArrowRight, ArrowUpRight } from 'lucide-react';
import { Section, SectionHead } from '@/components/site/section';
import { Tilt3D } from '@/components/site/tilt-3d';
import { RULES } from '@/domain/documents/rules';
import { CHECKLIST } from '@/domain/visits/checklist';
import { SCORE_PILLARS } from '@/domain/scoring/types';
import { RISK_DIMENSIONS } from '@/domain/risk/types';
import { NEGOTIATION_STATUSES } from '@/domain/negotiation/types';
import { CURRENT_SCORING_VERSION } from '@/domain/scoring/weights';
import { ALERT_KINDS } from '@/domain/alerts/types';
import { SHORTLIST_LIMIT } from '@/components/site/shortlist-limit';

const DOCUMENT_KINDS = new Set(RULES.flatMap((r) => r.kinds)).size;
const PERSONAS = Object.keys(CURRENT_SCORING_VERSION.weights).length;

interface Stage {
  readonly step: string;
  readonly name: string;
  readonly line: string;
  readonly figure: string;
  readonly unit: string;
  /** Absent when the stage has no surface behind it yet. */
  readonly href?: string;
}

const stages = (propertyHref: string): readonly Stage[] => [
  {
    step: '01',
    name: 'Discover',
    line: 'Ranked by the engine on location, pricing and risk, not by who paid to appear.',
    figure: String(PERSONAS),
    unit: 'buyer personas weighted',
    href: '/search',
  },
  {
    step: '02',
    name: 'Verify',
    line: 'Sale deeds, EC, khata, RERA and cost sheets, checked in the browser on typed input.',
    figure: String(RULES.length),
    unit: `rules · ${DOCUMENT_KINDS} document types`,
    href: '/document-ai',
  },
  {
    step: '03',
    name: 'Compare',
    line: 'Side by side on the same evidence, with a winner named only where the spread is real.',
    figure: String(SHORTLIST_LIMIT),
    unit: 'properties at once',
    href: '/compare',
  },
  {
    step: '04',
    name: 'Score',
    line: 'Weighted for who is buying, renormalised when evidence is missing, never scored as zero.',
    figure: String(SCORE_PILLARS.length),
    unit: 'published pillars',
    href: '/methodology',
  },
  {
    step: '05',
    name: 'Analyze',
    line: 'Every dimension scored separately. One with no evidence says so instead of averaging in.',
    figure: String(RISK_DIMENSIONS.length),
    unit: 'risk dimensions',
    href: propertyHref,
  },
  {
    step: '06',
    name: 'Visit',
    line: 'What you can only learn standing there, folded back into the score as first-party evidence.',
    figure: String(CHECKLIST.length),
    unit: 'checklist items',
    href: `${propertyHref}/visit`,
  },
  {
    step: '07',
    name: 'Negotiate',
    line: 'A walk-away price set while calm, and an offer sequence the summary cannot contradict.',
    figure: String(NEGOTIATION_STATUSES.length),
    unit: 'tracked offer states',
    href: `${propertyHref}/negotiate`,
  },
  {
    step: '08',
    name: 'Buy',
    line: 'Registration, stamp duty and handover are not built. Nothing here pretends otherwise.',
    figure: '—',
    unit: 'not built yet',
  },
  {
    step: '09',
    name: 'Monitor',
    line: 'Re-scored on every visit, with what moved since you last looked.',
    figure: String(ALERT_KINDS.length),
    unit: 'alert kinds',
    href: '/dashboard/alerts',
  },
];

const StageCard = ({ stage }: { stage: Stage }) => {
  const built = stage.href !== undefined;
  const body = (
    <div
      className={[
        'propiq-stage h-full rounded-xl border p-5 transition-colors',
        built
          ? 'border-[var(--border-subtle)] bg-[var(--surface-1)] hover:border-[var(--color-accent-500)]/55'
          : 'border-dashed border-[var(--border-strong)] bg-transparent',
      ].join(' ')}
    >
      <div className="flex items-baseline justify-between gap-3">
        <span
          data-figure
          className="text-[11px] font-semibold tracking-[0.18em] text-[var(--text-muted)]"
        >
          {stage.step}
        </span>
        {built ? (
          <ArrowUpRight
            aria-hidden
            className="size-4 text-[var(--text-muted)] transition-colors group-hover:text-[var(--color-accent-400)]"
          />
        ) : (
          <span className="rounded-full border border-[var(--border-strong)] px-2 py-0.5 text-[10px] uppercase tracking-wider text-[var(--text-muted)]">
            Not built
          </span>
        )}
      </div>

      <p className="mt-3 text-lg font-semibold text-[var(--text-primary)]">{stage.name}</p>

      <p className="mt-2 text-[13px] leading-relaxed text-[var(--text-secondary)]">{stage.line}</p>

      <p className="mt-4 border-t border-[var(--border-subtle)] pt-3">
        <span
          data-figure
          className={[
            'text-2xl font-bold leading-none',
            built ? 'text-[var(--text-accent)]' : 'text-[var(--text-muted)]',
          ].join(' ')}
        >
          {stage.figure}
        </span>
        <span className="mt-1.5 block text-[11px] uppercase tracking-[0.1em] text-[var(--text-muted)]">
          {stage.unit}
        </span>
      </p>
    </div>
  );

  return (
    <li className="min-w-0">
      <Tilt3D max={6} lift={12} className="h-full">
        {built ? (
          <Link
            href={stage.href as string}
            className="propiq-block-link group block h-full rounded-xl"
          >
            {body}
          </Link>
        ) : (
          body
        )}
      </Tilt3D>
    </li>
  );
};

export const JourneySection = ({ propertyHref }: { propertyHref: string }) => (
  <Section id="journey" tone="base">
    <SectionHead
      eyebrow="The buyer journey"
      title="Nine stages, and what the engine does at each."
      standfirst="Most portals stop at discovery. The decisions that cost money come after it — which is where the rest of this lives."
      action={
        <Link
          href="/methodology"
          className="inline-flex items-center gap-1.5 text-sm font-medium text-[var(--text-accent)] hover:underline"
        >
          How the scoring works <ArrowRight aria-hidden className="size-4" />
        </Link>
      }
    />

    <ol className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {stages(propertyHref).map((stage) => (
        <StageCard key={stage.step} stage={stage} />
      ))}
    </ol>

    <p className="mt-6 text-[11px] leading-relaxed text-[var(--text-muted)]">
      Every figure above is counted from the running engine, not written into this page. Eight
      stages have a surface behind them; the ninth says that it does not.
    </p>
  </Section>
);
