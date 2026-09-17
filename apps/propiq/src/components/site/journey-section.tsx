/**
 * The property intelligence journey.
 *
 * Nine stages from Discover to Monitor, each carrying the one figure that says
 * how much engine is behind it. Two rules hold it honest:
 *
 *  1. Every figure is the length of a live domain constant, read at render. A
 *     stage cannot advertise more than the engine behind it does, and none of
 *     it drifts when a list changes.
 *  2. A stage with no route gets no link and no figure. `Buy` is not built, and
 *     its card says so in a dashed frame rather than pointing at the nearest
 *     page that happens to exist. A flow diagram that quietly implies coverage
 *     it does not have is a fabricated claim, drawn instead of written.
 *
 * What changed from the first version: the cards used to print the constant's
 * own name underneath — `SHORTLIST_LIMIT`, `CURRENT_SCORING_VERSION.weights` —
 * as the provenance line. That is a real commitment aimed at the wrong reader.
 * A buyer does not know what a scoring-version weights map is, and showing them
 * one makes the page look like a debug view of itself. The figures are still
 * counted from the same constants; the line under them now says what the figure
 * means. The constant names live in `/methodology`, where someone who wants to
 * check them is already standing.
 */

import Link from 'next/link';
import {
  BellRing,
  Building2,
  FileCheck2,
  Gauge,
  Handshake,
  Home,
  ScanSearch,
  ShoppingCart,
  Users,
} from 'lucide-react';
import { Section, SectionHead } from '@/components/site/section';
import { RULES } from '@/domain/documents/rules';
import { CHECKLIST } from '@/domain/visits/checklist';
import { SCORE_PILLARS } from '@/domain/scoring/types';
import { RISK_DIMENSIONS } from '@/domain/risk/types';
import { NEGOTIATION_STATUSES } from '@/domain/negotiation/types';
import { ALERT_KINDS } from '@/domain/alerts/types';
import { CURRENT_SCORING_VERSION } from '@/domain/scoring/weights';
import { SHORTLIST_LIMIT } from '@/components/site/shortlist-limit';

const DOCUMENT_KINDS = new Set(RULES.flatMap((r) => r.kinds)).size;
const PERSONAS = Object.keys(CURRENT_SCORING_VERSION.weights).length;

interface Stage {
  readonly step: string;
  readonly name: string;
  readonly figure: string;
  readonly unit: string;
  /** One line on what the stage actually does for the person doing it. */
  readonly detail: string;
  readonly icon: typeof Users;
  /** Absent when nothing is built behind the stage. */
  readonly href?: string;
}

const stages = (propertyHref: string): readonly Stage[] => [
  {
    step: '01',
    name: 'Discover',
    figure: String(PERSONAS),
    unit: 'buyer profiles',
    detail:
      'The same property scores differently for a home, an investment or a purchase from abroad.',
    icon: Users,
    href: '/search',
  },
  {
    step: '02',
    name: 'Verify',
    figure: String(RULES.length),
    unit: `checks · ${DOCUMENT_KINDS} document types`,
    detail:
      'Title, encumbrance, Khata, RERA and approvals, read against rules rather than skimmed.',
    icon: FileCheck2,
    href: '/document-ai',
  },
  {
    step: '03',
    name: 'Compare',
    figure: String(SHORTLIST_LIMIT),
    unit: 'properties side by side',
    detail: 'Every dimension the engine computes, on one screen, with the differences called out.',
    icon: Building2,
    href: '/compare',
  },
  {
    step: '04',
    name: 'Score',
    figure: String(SCORE_PILLARS.length),
    unit: 'scoring pillars',
    detail: 'One 0–100 number with a published formula, a 95% band and every pillar openable.',
    icon: Gauge,
    href: '/methodology',
  },
  {
    step: '05',
    name: 'Analyze',
    figure: String(RISK_DIMENSIONS.length),
    unit: 'risk dimensions',
    detail: 'Legal, water, flood, delivery, liquidity and the rest — each with its own evidence.',
    icon: ScanSearch,
    href: propertyHref,
  },
  {
    step: '06',
    name: 'Visit',
    figure: String(CHECKLIST.length),
    unit: 'things to check on site',
    detail: 'What to photograph, what to ask and what to walk away from, on your phone.',
    icon: Home,
    href: `${propertyHref}/visit`,
  },
  {
    step: '07',
    name: 'Negotiate',
    figure: String(NEGOTIATION_STATUSES.length),
    unit: 'stages of an offer',
    detail: 'Where to open, where to stop and where to walk, argued from comparable transactions.',
    icon: Handshake,
    href: `${propertyHref}/negotiate`,
  },
  {
    step: '08',
    name: 'Buy',
    figure: '—',
    unit: 'Early access',
    detail: 'Registration, payment schedule and handover tracking. Not built yet, so not claimed.',
    icon: ShoppingCart,
  },
  {
    step: '09',
    name: 'Monitor',
    figure: String(ALERT_KINDS.length),
    unit: 'kinds of alert',
    detail: 'Price, RERA status, construction, a new comparable — told to you, not looked up.',
    icon: BellRing,
    href: '/dashboard/alerts',
  },
];

const StageCard = ({ stage }: { stage: Stage }) => {
  const built = stage.href !== undefined;
  const Icon = stage.icon;

  const body = (
    <div
      className={[
        'propiq-stage-card flex h-full flex-col rounded-2xl p-5',
        built ? '' : 'propiq-stage-card--empty',
      ].join(' ')}
    >
      <div className="flex items-center gap-3">
        <span
          className={[
            'inline-flex size-10 shrink-0 items-center justify-center rounded-xl',
            built
              ? 'propiq-iris-gradient text-white'
              : 'border border-dashed border-[var(--border-strong)] text-[var(--text-muted)]',
          ].join(' ')}
        >
          <Icon aria-hidden className="size-[18px]" />
        </span>
        <div className="min-w-0">
          <p
            data-figure
            className="text-[10px] font-semibold tracking-[0.18em] text-[var(--text-muted)]"
          >
            {stage.step}
          </p>
          <p className="text-[15px] font-semibold leading-tight">{stage.name}</p>
        </div>
      </div>

      <p className="mt-4 text-[13px] leading-snug text-[var(--text-secondary)]">{stage.detail}</p>

      <p className="mt-auto pt-4 text-[13px]">
        {built ? (
          <>
            <span data-figure className="propiq-iris-text text-xl font-bold">
              {stage.figure}
            </span>{' '}
            <span className="text-[var(--text-muted)]">{stage.unit}</span>
          </>
        ) : (
          <span className="inline-flex items-center rounded-full border border-[var(--border-strong)] px-2.5 py-1 text-[11px] font-medium text-[var(--text-muted)]">
            {stage.unit}
          </span>
        )}
      </p>
    </div>
  );

  return (
    <li className="propiq-stage-item">
      {built ? (
        <Link href={stage.href!} className="propiq-block-link block h-full">
          {body}
        </Link>
      ) : (
        body
      )}
    </li>
  );
};

export const JourneySection = ({ propertyHref }: { propertyHref: string }) => (
  <Section tone="deep" id="journey">
    <SectionHead
      eyebrow="The journey"
      title="Nine stages, one continuous record."
      standfirst="Each stage hands the next one its evidence, so by the time you are negotiating, the argument is already written. Every figure below is counted from what is actually built — the one stage that is not says so."
    />

    {/* A rail on a wide screen, a timeline on a narrow one. Both are an ordered
        list, because the order is the content. */}
    <ol className="propiq-journey mt-10">
      {stages(propertyHref).map((s) => (
        <StageCard key={s.step} stage={s} />
      ))}
    </ol>
  </Section>
);
