/**
 * The hero: the property intelligence command centre.
 *
 * The composition is a split — argument on the left, evidence on the right —
 * and the right-hand side is the product's actual output, not a picture of it.
 * Every figure in a floating readout is read off the showcase property that
 * the rest of the page is built from: the same scoring pass, the same verdict,
 * the same 95% band. So the hero cannot say 86 while the score section says 76,
 * and there is no second set of numbers to keep in sync.
 *
 * When no property source is connected there is nothing to read, and the
 * readouts are simply absent. The scene and the argument stand on their own —
 * what does not happen is a fallback set of plausible figures, which is the
 * one thing this product will not draw.
 *
 * The scene is SVG and CSS. See `intelligence-nodes.tsx` for why there is no
 * WebGL path, and therefore no low-power fallback to keep working.
 */

import Link from 'next/link';
import { ArrowRight, MessageSquareText, ShieldCheck } from 'lucide-react';
import { NodeField } from '@/components/site/intelligence-nodes';
import { HeroSearch } from '@/components/site/hero-search';
import { SCORE_PILLARS } from '@/domain/scoring/types';
import { RISK_DIMENSIONS } from '@/domain/risk/types';
import { RULES } from '@/domain/documents/rules';
import { formatINR, formatPercent } from '@/lib/utils';
import type { SiteProperty } from '@/site/types';

/** Counted from the engine, phrased for a reader. Never the constant's name. */
const PROOF = [
  { figure: String(SCORE_PILLARS.length), label: 'scoring pillars' },
  { figure: String(RISK_DIMENSIONS.length), label: 'risk dimensions' },
  { figure: String(RULES.length), label: 'document checks' },
] as const;

const RISK_WORD = {
  low: 'Low',
  moderate: 'Moderate',
  elevated: 'Elevated',
  high: 'High',
  unknown: 'Unknown',
} as const;

/**
 * One floating readout.
 *
 * `caption` is not decoration — it is the thing that stops a number being a
 * claim. A score with no band and a fair value with no confidence are both
 * assertions the evidence does not support.
 */
const Readout = ({
  label,
  value,
  caption,
  tone,
  className,
}: {
  label: string;
  value: string;
  caption?: string;
  tone?: string;
  className?: string;
}) => (
  <div className={`propiq-glass propiq-readout rounded-xl px-4 py-3 ${className ?? ''}`}>
    <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--text-muted)]">
      {label}
    </p>
    <p
      data-figure
      className="mt-1 text-2xl font-semibold leading-none"
      style={tone ? { color: tone } : undefined}
    >
      {value}
    </p>
    {caption && <p className="mt-1.5 text-[11px] text-[var(--text-secondary)]">{caption}</p>}
  </div>
);

export const HeroSection = ({
  showcase,
  localities,
}: {
  showcase: SiteProperty | undefined;
  localities: readonly string[];
}) => (
  <section className="propiq-hero relative isolate overflow-hidden">
    {/* ------------------------------------------------------------- scene */}
    <div aria-hidden className="propiq-cityplate">
      <svg
        viewBox="0 0 1200 240"
        preserveAspectRatio="none"
        className="propiq-skyline"
        aria-hidden
        focusable="false"
      >
        <defs>
          <linearGradient id="propiq-tower" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--color-iris-300)" stopOpacity="0.5" />
            <stop offset="100%" stopColor="var(--color-iris-300)" stopOpacity="0.02" />
          </linearGradient>
        </defs>
        {/* Hand-placed blocks: a generated skyline clusters and reads as noise. */}
        {[
          [40, 96],
          [86, 148],
          [132, 64],
          [174, 182],
          [226, 112],
          [272, 208],
          [326, 88],
          [368, 140],
          [414, 172],
          [468, 74],
          [512, 196],
          [566, 118],
          [612, 160],
          [660, 92],
          [706, 214],
          [758, 130],
          [806, 68],
          [852, 178],
          [904, 104],
          [950, 152],
          [998, 82],
          [1044, 190],
          [1096, 124],
          [1144, 156],
        ].map(([x, h]) => (
          <rect
            key={x}
            x={x}
            y={240 - (h ?? 0)}
            width="30"
            height={h}
            rx="2"
            fill="url(#propiq-tower)"
          />
        ))}
      </svg>
      <NodeField />
    </div>

    {/* The page ground, faded up under the scene so the section below joins it
        rather than butting against a hard edge. */}
    <div
      aria-hidden
      className="pointer-events-none absolute inset-x-0 bottom-0 h-40 bg-gradient-to-b from-transparent to-[var(--surface-0)]"
    />

    <div className="relative mx-auto grid max-w-7xl items-start gap-12 px-4 pb-20 pt-14 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)] lg:gap-12 lg:pb-24 lg:pt-16">
      {/* --------------------------------------------------------- argument */}
      <div className="max-w-2xl">
        <p className="propiq-eyebrow-pill">Property decision intelligence</p>

        {/* `balance` and not a hand-placed break: the two clauses are the
            structure, and inside each one the browser knows the measure
            better than a hardcoded <br> does at every width. */}
        <h1 className="propiq-display mt-5 text-balance text-[2.5rem] leading-[1.04] tracking-[-0.03em] sm:text-[3.2rem] lg:text-[3.1rem] xl:text-[3.45rem]">
          <span className="block">Find the right property.</span>
          <span className="propiq-iris-text block">Understand the opportunity.</span>
        </h1>

        <p className="mt-6 max-w-xl text-base leading-relaxed text-[var(--text-secondary)] sm:text-lg">
          Discover projects, understand locations, benchmark prices, evaluate developers and weigh
          risk against return — through one engine whose formula is published and whose every number
          carries its evidence.
        </p>

        <div className="mt-8">
          <HeroSearch localities={localities} />
        </div>

        <div className="mt-7 flex flex-wrap items-center gap-3">
          <Link
            href="/search"
            className="propiq-btn-primary inline-flex h-12 items-center gap-2 rounded-lg px-6 text-sm font-semibold text-white"
          >
            Explore properties <ArrowRight aria-hidden className="size-4" />
          </Link>
          <Link
            href="/valuation"
            className="inline-flex h-12 items-center gap-2 rounded-lg border border-[var(--border-strong)] px-5 text-sm font-medium transition-colors hover:bg-[var(--surface-1)]"
          >
            Analyze a property
          </Link>
          <Link
            href="/copilot"
            className="inline-flex h-12 items-center gap-2 rounded-lg px-4 text-sm font-medium text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)]"
          >
            <MessageSquareText aria-hidden className="size-4" /> Ask PropIQ
          </Link>
        </div>

        <dl className="mt-10 flex flex-wrap gap-x-8 gap-y-4 border-t border-[var(--border-subtle)] pt-6">
          {PROOF.map((p) => (
            <div key={p.label}>
              <dt className="sr-only">{p.label}</dt>
              <dd>
                <span data-figure className="text-2xl font-semibold">
                  {p.figure}
                </span>
                <span className="ml-2 text-sm text-[var(--text-muted)]">{p.label}</span>
              </dd>
            </div>
          ))}
        </dl>
      </div>

      {/* -------------------------------------------------------- readouts */}
      {/* Absent, not faked, when there is no property to read them off. */}
      {showcase && (
        <div className="lg:pt-6">
          {/* An offset stack rather than a scatter. Absolute placement put the
              last readout below the section and let the middle two collide at
              awkward widths; stepping them across a flow column keeps the
              floating feel and cannot overflow the box at any size. */}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-1 lg:gap-4">
            <Readout
              className="lg:mr-[22%]"
              label="PropIQ Score"
              value={
                showcase.propiqScore === undefined ? '—' : String(Math.round(showcase.propiqScore))
              }
              caption={
                showcase.scoreBand
                  ? `95% band ${showcase.scoreBand.low}–${showcase.scoreBand.high} · ${formatPercent(showcase.coverage * 100, 0)} evidence coverage`
                  : 'Withheld — not enough evidence'
              }
            />
            <Readout
              className="lg:ml-[16%]"
              label="Fair value"
              value={showcase.fairValueMid === undefined ? '—' : formatINR(showcase.fairValueMid)}
              caption={
                showcase.fairValueLow !== undefined && showcase.fairValueHigh !== undefined
                  ? `Range ${formatINR(showcase.fairValueLow)} – ${formatINR(showcase.fairValueHigh)}`
                  : 'No comparable set'
              }
            />
            <Readout
              className="lg:mr-[28%]"
              label="Risk profile"
              value={RISK_WORD[showcase.riskBand]}
              caption={`Across ${RISK_DIMENSIONS.length} dimensions, each with its own evidence`}
            />
            <Readout
              className="lg:ml-[10%]"
              label="Asking vs fair value"
              value={
                showcase.priceDeviationPercent >= 0
                  ? `${formatPercent(showcase.priceDeviationPercent, 1)} over`
                  : `${formatPercent(Math.abs(showcase.priceDeviationPercent), 1)} under`
              }
              tone={showcase.priceDeviationPercent >= 0 ? 'var(--color-avoid)' : 'var(--color-buy)'}
              caption={`${showcase.name} · ${showcase.locality}`}
            />
          </div>

          <p className="mt-4 flex items-center gap-1.5 text-[11px] text-[var(--text-muted)]">
            <ShieldCheck aria-hidden className="size-3.5 shrink-0" />
            Computed live by the scoring engine — not a mock-up.
          </p>
        </div>
      )}
    </div>
  </section>
);
