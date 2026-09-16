/**
 * The hero: the buyer journey, end to end.
 *
 * Nine stages from Discover to Monitor, each carrying the one figure that says
 * how much engine is behind it and naming the constant that figure came from.
 *
 * Two rules hold it honest, and both are visible on the page:
 *
 *  1. Every figure is the `.length` of a live domain constant, read at render.
 *     The source line under each card names it, so a reader can go and check.
 *     A stage cannot advertise more than the engine behind it does, and none
 *     of it drifts when a list changes.
 *  2. A stage with no route gets no link and no figure. `Buy` is not built,
 *     and its card says so in a dashed frame rather than pointing at the
 *     nearest page that happens to exist. A flow diagram that quietly implies
 *     coverage it does not have is a fabricated claim, drawn instead of
 *     written.
 */

import Link from 'next/link';
import {
  ArrowRight,
  BellRing,
  Building2,
  ClipboardCheck,
  FileCheck2,
  Gauge,
  Handshake,
  Home,
  LineChart,
  ScanSearch,
  ShoppingCart,
  TrendingUp,
  Users,
} from 'lucide-react';
import { BrandLockup } from '@/components/brand/brand-mark';
import { RULES } from '@/domain/documents/rules';
import { CHECKLIST } from '@/domain/visits/checklist';
import { SCORE_PILLARS } from '@/domain/scoring/types';
import { RISK_DIMENSIONS } from '@/domain/risk/types';
import { NEGOTIATION_STATUSES } from '@/domain/negotiation/types';
import { ALERT_KINDS } from '@/domain/alerts/types';
import { CURRENT_SCORING_VERSION } from '@/domain/scoring/weights';
import { SHORTLIST_LIMIT } from '@/components/site/shortlist-limit';
import type { SiteProperty } from '@/site/types';

const DOCUMENT_KINDS = new Set(RULES.flatMap((r) => r.kinds)).size;
const PERSONAS = Object.keys(CURRENT_SCORING_VERSION.weights).length;

interface Stage {
  readonly step: string;
  readonly name: string;
  readonly figure: string;
  readonly unit: string;
  /** The constant the figure was counted from, printed on the card. */
  readonly source: string;
  readonly icon: typeof Users;
  /** Absent when nothing is built behind the stage. */
  readonly href?: string;
}

const stages = (propertyHref: string): readonly Stage[] => [
  {
    step: '01',
    name: 'Discover',
    figure: String(PERSONAS),
    unit: 'personas weighted',
    source: 'CURRENT_SCORING_VERSION.weights',
    icon: Users,
    href: '/search',
  },
  {
    step: '02',
    name: 'Verify',
    figure: String(RULES.length),
    unit: `rules · ${DOCUMENT_KINDS} doc types`,
    source: 'RULES',
    icon: FileCheck2,
    href: '/document-ai',
  },
  {
    step: '03',
    name: 'Compare',
    figure: String(SHORTLIST_LIMIT),
    unit: 'at once',
    source: 'SHORTLIST_LIMIT',
    icon: Building2,
    href: '/compare',
  },
  {
    step: '04',
    name: 'Score',
    figure: String(SCORE_PILLARS.length),
    unit: 'pillars',
    source: 'SCORE_PILLARS',
    icon: Gauge,
    href: '/methodology',
  },
  {
    step: '05',
    name: 'Analyze',
    figure: String(RISK_DIMENSIONS.length),
    unit: 'risk dimensions',
    source: 'RISK_DIMENSIONS',
    icon: ScanSearch,
    href: propertyHref,
  },
  {
    step: '06',
    name: 'Visit',
    figure: String(CHECKLIST.length),
    unit: 'checklist items',
    source: 'CHECKLIST',
    icon: Home,
    href: `${propertyHref}/visit`,
  },
  {
    step: '07',
    name: 'Negotiate',
    figure: String(NEGOTIATION_STATUSES.length),
    unit: 'offer states',
    source: 'NEGOTIATION_STATUSES',
    icon: Handshake,
    href: `${propertyHref}/negotiate`,
  },
  {
    step: '08',
    name: 'Buy',
    figure: '—',
    unit: 'Not built yet',
    source: 'no route',
    icon: ShoppingCart,
  },
  {
    step: '09',
    name: 'Monitor',
    figure: String(ALERT_KINDS.length),
    unit: 'alert kinds',
    source: 'ALERT_KINDS',
    icon: BellRing,
    href: '/dashboard/alerts',
  },
];

const PROMISES = [
  {
    icon: LineChart,
    title: 'Data-Driven Decisions',
    line: 'Less guesswork. More certainty.',
  },
  { icon: TrendingUp, title: 'Smarter Real Estate', line: 'From insight to impact.' },
  { icon: ClipboardCheck, title: 'Stronger Communities', line: 'Cities that grow better.' },
] as const;

const StageCard = ({ stage }: { stage: Stage }) => {
  const built = stage.href !== undefined;
  const Icon = stage.icon;

  const card = (
    <div
      className={[
        'propiq-stage-card flex h-full flex-col items-center rounded-2xl px-3 pb-4 pt-5 text-center',
        built ? '' : 'propiq-stage-card--empty',
      ].join(' ')}
    >
      <span
        className={[
          'inline-flex size-11 items-center justify-center rounded-xl',
          built
            ? 'propiq-iris-gradient text-white'
            : 'border border-[var(--border-strong)] text-[var(--text-muted)]',
        ].join(' ')}
      >
        <Icon aria-hidden className="size-5" />
      </span>

      <span
        data-figure
        className={[
          'mt-3 inline-flex size-7 items-center justify-center rounded-full text-[11px] font-bold',
          built
            ? 'bg-[var(--color-iris-600)] text-white'
            : 'bg-[var(--surface-2)] text-[var(--text-muted)]',
        ].join(' ')}
      >
        {stage.step}
      </span>

      <p className="mt-2.5 text-sm font-bold text-[var(--text-primary)]">{stage.name}</p>

      <p className="mt-2 text-[13px] leading-snug text-[var(--text-secondary)]">
        {built ? (
          <>
            <span data-figure className="propiq-iris-text text-lg font-extrabold">
              {stage.figure}
            </span>{' '}
            {stage.unit}
          </>
        ) : (
          <span className="text-[var(--text-muted)]">{stage.unit}</span>
        )}
      </p>

      {/* `items-center` on the card shrink-wraps its children, so this needs an
          explicit full width or a long identifier runs straight past the card
          edge instead of wrapping inside it. */}
      <p className="mt-auto w-full pt-3 text-[9px] uppercase leading-tight tracking-[0.08em] text-[var(--text-muted)] [overflow-wrap:anywhere]">
        <span className="block">Source:</span>
        <span className="font-medium">{stage.source}</span>
      </p>
    </div>
  );

  return (
    <li className="w-[152px] shrink-0 snap-start xl:w-auto">
      {built ? (
        <Link
          href={stage.href as string}
          className="propiq-block-link block h-full rounded-2xl focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-iris-600)]"
        >
          {card}
        </Link>
      ) : (
        card
      )}
    </li>
  );
};

export const HeroSection = ({ showcase }: { showcase: SiteProperty | undefined }) => {
  const propertyHref = showcase ? `/property/${showcase.slug}` : '/search';

  return (
    <section className="propiq-hero-light relative isolate overflow-hidden">
      <div className="relative mx-auto max-w-[1480px] px-4 pb-24 pt-12 sm:pt-14">
        <p className="mx-auto max-w-2xl text-center text-[10px] font-semibold uppercase leading-relaxed tracking-[0.28em] text-[var(--text-muted)] sm:text-[11px]">
          Real estate intelligence for a brighter tomorrow
        </p>

        <div className="mt-7 flex justify-center">
          <BrandLockup width={230} />
        </div>

        <h1 className="mt-6 text-center text-[clamp(2.1rem,5.4vw,3.6rem)] font-extrabold leading-[1.04] tracking-[-0.03em]">
          Property Intelligence <span className="propiq-iris-text">Journey</span>
        </h1>

        <p className="mx-auto mt-4 max-w-2xl text-center text-base leading-relaxed text-[var(--text-secondary)] sm:text-lg">
          From discovery to monitoring, PropIQ turns a property listing into a decision you can
          argue with — every number sourced, every gap admitted.
        </p>

        {/* Nine across at xl, a snapping rail below it. The connectors only
            make sense in one row, so the row is what every width gets. */}
        <ol className="mt-12 flex snap-x snap-mandatory gap-3 overflow-x-auto pb-3 xl:grid xl:grid-cols-9 xl:overflow-visible xl:pb-0">
          {stages(propertyHref).map((stage) => (
            <StageCard key={stage.step} stage={stage} />
          ))}
        </ol>

        <div className="mt-10 flex justify-center">
          <Link
            href="/search"
            className="propiq-iris-gradient inline-flex h-14 items-center gap-3 rounded-full px-9 text-base font-semibold text-white shadow-[0_18px_40px_-16px_rgba(43,73,200,0.75)] transition-transform hover:-translate-y-0.5"
          >
            Turn Property Data into Opportunity
            <span className="inline-flex size-7 items-center justify-center rounded-full bg-white/20">
              <ArrowRight aria-hidden className="size-4" />
            </span>
          </Link>
        </div>

        <ul className="mx-auto mt-12 flex max-w-4xl flex-col items-stretch justify-center gap-4 sm:flex-row sm:items-center sm:gap-10">
          {PROMISES.map((p) => {
            const Icon = p.icon;
            return (
              <li key={p.title} className="flex items-center gap-3">
                <span className="inline-flex size-11 shrink-0 items-center justify-center rounded-full bg-[var(--color-iris-100)] text-[var(--color-iris-600)]">
                  <Icon aria-hidden className="size-5" />
                </span>
                <span>
                  <span className="block text-sm font-bold text-[var(--text-primary)]">
                    {p.title}
                  </span>
                  <span className="block text-[13px] text-[var(--text-secondary)]">{p.line}</span>
                </span>
              </li>
            );
          })}
        </ul>

        <p className="mt-10 text-center text-[11px] leading-relaxed text-[var(--text-muted)]">
          Every figure above is counted from the running engine at render, not written into this
          page. Eight stages have a surface behind them; the ninth says that it does not.
        </p>
      </div>

      {/* The light world resolves into the teal one rather than cutting to it. */}
      <div aria-hidden className="propiq-hero-dissolve h-24 w-full" />
    </section>
  );
};
