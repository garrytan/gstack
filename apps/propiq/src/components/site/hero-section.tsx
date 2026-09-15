/**
 * The hero.
 *
 * Copy is fixed; every figure on it is computed. The floating cards read from
 * the showcase property's real payload, so the score beside the skyline is
 * the same number its detail page renders. Where a figure cannot be computed
 * the card is not shown, rather than shown with a placeholder.
 */

import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { DECISION_LABELS } from '@/domain/decision/engine';
import { formatINR, formatPercent, formatPsf } from '@/lib/utils';
import { GlassMetricCard } from '@/components/site/glass-metric-card';
import { HeroSceneSlot } from '@/components/site/hero-scene-slot';
import type { SiteProperty } from '@/site/types';

const CHIPS = [
  'PropIQ Score',
  'Price Intelligence',
  'Builder Trust',
  'Risk Analysis',
  'Locality Insights',
] as const;

export const HeroSection = ({ showcase }: { showcase: SiteProperty | undefined }) => (
  <section className="propiq-dark relative isolate overflow-hidden">
    <div className="absolute inset-0 -z-10">
      <HeroSceneSlot className="size-full" />
    </div>
    {/* The copy side needs contrast over a moving scene, so the ground is
        pulled back on the left and released on the right. */}
    <div
      aria-hidden
      className="absolute inset-0 -z-10 bg-gradient-to-r from-[#070b16] via-[#070b16]/85 to-[#070b16]/25 lg:to-transparent"
    />

    <div className="relative mx-auto grid max-w-7xl gap-10 px-4 pb-28 pt-16 lg:min-h-[860px] lg:pb-32 lg:grid-cols-[minmax(0,44fr)_minmax(0,56fr)] lg:items-center lg:py-20">
      <div className="propiq-reveal min-w-0">
        <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-[var(--color-brand-cyan-400)]">
          Real estate intelligence
        </p>

        <h1 className="mt-5 text-[2.5rem] font-bold leading-[1.04] tracking-tight sm:text-[2.9rem] xl:text-[3.15rem]">
          <span className="block">Find the Right Property.</span>
          <span className="propiq-brand-text block">Understand the Opportunity.</span>
        </h1>

        <p className="mt-5 max-w-xl text-base leading-relaxed text-[var(--text-secondary)] sm:text-lg">
          Discover projects, compare locations, benchmark prices, evaluate developers, and uncover
          investment potential through one intelligent real-estate platform.
        </p>

        <div className="mt-8 flex flex-wrap gap-3">
          <Link
            href="/search"
            className="propiq-brand-gradient inline-flex h-12 items-center gap-2 rounded-lg px-6 text-sm font-semibold text-white transition-opacity hover:opacity-90"
          >
            Explore Properties <ArrowRight aria-hidden className="size-4" />
          </Link>
          <Link
            href={showcase ? `/property/${showcase.slug}` : '/search'}
            className="inline-flex h-12 items-center rounded-lg border border-white/20 px-6 text-sm font-semibold text-white transition-colors hover:bg-white/5"
          >
            Analyze a Property
          </Link>
        </div>

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
        <div className="propiq-reveal min-w-0 lg:pl-6" style={{ animationDelay: '120ms' }}>
          <div className="grid gap-3 sm:grid-cols-2">
            {showcase.propiqScore !== undefined && (
              <GlassMetricCard
                label="PropIQ Score"
                value={`${showcase.propiqScore.toFixed(0)} / 100`}
                note={
                  showcase.scoreBand
                    ? `95% band ${showcase.scoreBand.low}–${showcase.scoreBand.high}`
                    : undefined
                }
                accent="#42c9e8"
                dataStatus={showcase.dataStatus}
              />
            )}
            <GlassMetricCard
              label="Price benchmark"
              value={formatPsf(showcase.pricePerSqFt)}
              note={`${formatPercent(Math.abs(showcase.priceDeviationPercent), 1)} ${
                showcase.priceDeviationPercent < 0 ? 'under' : 'over'
              } our central estimate`}
              dataStatus={showcase.dataStatus}
            />
            <GlassMetricCard
              label="Verdict"
              value={DECISION_LABELS[showcase.decision]}
              note={`${(showcase.verdictConfidence * 100).toFixed(0)}% confidence`}
              dataStatus={showcase.dataStatus}
            />
            <GlassMetricCard
              label="Risk"
              value={showcase.riskBand.replace(/^\w/, (c) => c.toUpperCase())}
              note={
                showcase.materialRisks.length > 0
                  ? `${showcase.materialRisks.length} material`
                  : 'Nothing material flagged'
              }
              dataStatus={showcase.dataStatus}
            />
          </div>

          <div className="propiq-site-glass mt-3 rounded-xl p-4">
            <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-white/55">
              Featured analysis
            </p>
            <p className="mt-1.5 text-base font-semibold text-white">{showcase.name}</p>
            <p className="text-xs text-white/60">
              {showcase.locality}, {showcase.city} · {showcase.bhk} BHK · {showcase.sizeSqFt} sqft
            </p>
            <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
              <p data-figure className="text-lg font-semibold text-white">
                {formatINR(showcase.price)}
              </p>
              <Link
                href={`/property/${showcase.slug}`}
                className="inline-flex items-center gap-1 text-xs font-medium text-[var(--color-brand-cyan-400)] hover:underline"
              >
                View intelligence <ArrowRight aria-hidden className="size-3.5" />
              </Link>
            </div>
          </div>
        </div>
      )}
    </div>
  </section>
);
