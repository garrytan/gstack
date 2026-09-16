/**
 * The hero.
 *
 * Copy is fixed; every figure on it is computed. The floating cards read from
 * the showcase property's real payload, so the score beside the skyline is
 * the same number its detail page renders. Where a figure cannot be computed
 * the card is not shown, rather than shown with a placeholder.
 *
 * The proof strip under the calls to action counts the live domain constants
 * — pillars, risk dimensions, document rules — rather than carrying typed
 * numbers that would drift the first time one of those lists changed.
 */

import Link from 'next/link';
import { ArrowRight, ShieldCheck } from 'lucide-react';
import { DECISION_LABELS } from '@/domain/decision/engine';
import { SCORE_PILLARS } from '@/domain/scoring/types';
import { RISK_DIMENSIONS } from '@/domain/risk/types';
import { RULES } from '@/domain/documents/rules';
import { formatINR, formatPercent, formatPsf } from '@/lib/utils';
import { GlassMetricCard } from '@/components/site/glass-metric-card';
import { HeroBackground } from '@/components/site/hero-background';
import { HeroParallax } from '@/components/site/hero-parallax';
import { ScoreDial } from '@/components/propiq/score-dial';
import { Tilt3D } from '@/components/site/tilt-3d';
import type { SiteProperty } from '@/site/types';

const CHIPS = [
  'PropIQ Score',
  'Price Intelligence',
  'Builder Trust',
  'Risk Analysis',
  'Locality Insights',
] as const;

/** Counted from the engines themselves, so the strip cannot overstate them. */
const PROOF = [
  { figure: String(SCORE_PILLARS.length), label: 'scoring pillars' },
  { figure: String(RISK_DIMENSIONS.length), label: 'risk dimensions' },
  { figure: String(RULES.length), label: 'document rules' },
  { figure: '95%', label: 'confidence band' },
] as const;

export const HeroSection = ({ showcase }: { showcase: SiteProperty | undefined }) => (
  <section className="propiq-dark relative isolate overflow-hidden">
    <HeroParallax>
      <HeroBackground />
    </HeroParallax>
    {/* The copy side needs contrast over a moving scene, so the ground is
        pulled back on the left and released on the right. */}
    <div
      aria-hidden
      className="absolute inset-0 -z-10 bg-gradient-to-r from-[#061c1d]/88 via-[#0a2a2b]/40 to-transparent"
    />

    <div className="relative mx-auto grid max-w-7xl gap-12 px-4 pb-24 pt-14 lg:min-h-[820px] lg:grid-cols-[minmax(0,47fr)_minmax(0,53fr)] lg:items-center lg:gap-10 lg:pb-28 lg:pt-16">
      <div className="propiq-reveal min-w-0">
        <p className="inline-flex items-center gap-2 rounded-full border border-[var(--color-accent-500)]/30 bg-[var(--color-accent-500)]/10 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--color-accent-400)]">
          <ShieldCheck aria-hidden className="size-3.5" />
          Real estate intelligence
        </p>

        {/* The opening line is the one piece of type on the page that gets to
            be loud. `clamp` rather than breakpoints so it scales with the
            viewport instead of stepping at three widths. */}
        <h1 className="mt-6 font-bold leading-[0.98] tracking-[-0.025em] text-[clamp(2.6rem,6.2vw,4.1rem)]">
          <span className="block">Find the Right Property.</span>
          <span className="propiq-hero-accent block">Understand the Opportunity.</span>
        </h1>

        <p className="mt-6 max-w-xl text-lg leading-relaxed text-[var(--text-secondary)]">
          Discover projects, compare locations, benchmark prices, evaluate developers, and uncover
          investment potential through one intelligent real-estate platform.
        </p>

        <div className="mt-9 flex flex-wrap gap-3">
          <Link
            href="/search"
            className="propiq-cta-glow propiq-brand-gradient inline-flex h-13 items-center gap-2 rounded-xl px-7 text-[15px] font-semibold text-white transition-transform hover:-translate-y-0.5"
          >
            Explore Properties <ArrowRight aria-hidden className="size-4" />
          </Link>
          <Link
            href={showcase ? `/property/${showcase.slug}` : '/search'}
            className="inline-flex h-13 items-center rounded-xl border border-white/25 bg-white/[0.03] px-7 text-[15px] font-semibold text-white transition-colors hover:border-white/45 hover:bg-white/[0.08]"
          >
            Analyze a Property
          </Link>
        </div>

        <dl className="mt-10 grid max-w-lg grid-cols-2 gap-x-6 gap-y-5 border-t border-white/10 pt-7 sm:grid-cols-4 sm:gap-x-4">
          {PROOF.map((item) => (
            <div key={item.label}>
              <dt className="sr-only">{item.label}</dt>
              <dd>
                <span
                  data-figure
                  className="propiq-hero-accent block text-2xl font-bold leading-none"
                >
                  {item.figure}
                </span>
                <span className="mt-1.5 block text-[11px] uppercase tracking-[0.12em] text-[var(--text-muted)]">
                  {item.label}
                </span>
              </dd>
            </div>
          ))}
        </dl>

        <ul className="mt-8 flex flex-wrap gap-2">
          {CHIPS.map((chip) => (
            <li
              key={chip}
              className="rounded-full border border-white/12 bg-white/[0.04] px-3 py-1.5 text-xs text-[var(--text-secondary)]"
            >
              {chip}
            </li>
          ))}
        </ul>
      </div>

      {showcase && (
        <div className="propiq-reveal min-w-0" style={{ animationDelay: '120ms' }}>
          {/* The score leads, at the size it deserves: it is the product's
              one headline number, and four equal cards gave it no more
              weight than the risk band. */}
          <Tilt3D max={5} lift={14}>
            <div className="propiq-site-glass propiq-hero-panel rounded-2xl p-6">
              <div className="flex items-center gap-6">
                {showcase.propiqScore !== undefined && (
                  <ScoreDial
                    score={showcase.propiqScore}
                    confidence={showcase.verdictConfidence}
                    size={128}
                  />
                )}
                <div className="min-w-0">
                  <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-white/55">
                    Featured analysis
                  </p>
                  <p className="mt-1.5 truncate text-lg font-semibold text-white">
                    {showcase.name}
                  </p>
                  <p className="mt-0.5 text-xs text-white/60">
                    {showcase.locality}, {showcase.city} · {showcase.bhk} BHK · {showcase.sizeSqFt}{' '}
                    sqft
                  </p>
                  <p data-figure className="mt-3 text-2xl font-bold text-white">
                    {formatINR(showcase.price)}
                  </p>
                  {showcase.scoreBand && (
                    <p className="mt-1 text-[11px] text-white/55">
                      95% band {showcase.scoreBand.low}–{showcase.scoreBand.high} ·{' '}
                      {(showcase.verdictConfidence * 100).toFixed(0)}% confidence
                    </p>
                  )}
                </div>
              </div>

              <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-white/10 pt-4">
                <span className="inline-flex items-center gap-2 text-sm">
                  <span
                    className="inline-block size-2 rounded-full"
                    style={{ background: 'var(--color-buy)' }}
                    aria-hidden
                  />
                  <span className="font-semibold text-white">
                    {DECISION_LABELS[showcase.decision]}
                  </span>
                  <span className="text-white/55">
                    · {showcase.riskBand.replace(/^\w/, (c) => c.toUpperCase())} risk
                  </span>
                </span>
                <Link
                  href={`/property/${showcase.slug}`}
                  className="inline-flex items-center gap-1 text-xs font-semibold text-[var(--color-accent-400)] hover:underline"
                >
                  View intelligence <ArrowRight aria-hidden className="size-3.5" />
                </Link>
              </div>
            </div>
          </Tilt3D>

          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <Tilt3D>
              <GlassMetricCard
                label="Price benchmark"
                value={formatPsf(showcase.pricePerSqFt)}
                note={`${formatPercent(Math.abs(showcase.priceDeviationPercent), 1)} ${
                  showcase.priceDeviationPercent < 0 ? 'under' : 'over'
                } our central estimate`}
                dataStatus={showcase.dataStatus}
              />
            </Tilt3D>
            <Tilt3D>
              <GlassMetricCard
                label="Material risks"
                value={
                  showcase.materialRisks.length > 0 ? String(showcase.materialRisks.length) : 'None'
                }
                note={
                  showcase.materialRisks.length > 0
                    ? `of ${RISK_DIMENSIONS.length} dimensions flagged material`
                    : `Nothing material across ${RISK_DIMENSIONS.length} dimensions`
                }
                dataStatus={showcase.dataStatus}
              />
            </Tilt3D>
          </div>
        </div>
      )}
    </div>
  </section>
);
