/**
 * The verdict card in the hero.
 *
 * A hero that describes a product is weaker than a hero that shows its
 * output. This is one real property's actual verdict — the same payload the
 * Property Intelligence Page renders, from the same use case — so the first
 * thing a visitor sees is the thing they came for, not a claim about it.
 *
 * It carries its own data-status chip. A card lifted out of context still has
 * to say what backs it.
 */

import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import type { PropertyIntelligence } from '@/server/intelligence';
import { DECISION_LABELS } from '@/domain/decision/engine';
import type { Decision } from '@/domain/decision/engine';
import { ScoreDial } from '@/components/propiq/score-dial';
import { formatINR, formatPercent, formatSignedPercent } from '@/lib/utils';

const DECISION_COLOR: Readonly<Record<Decision, string>> = {
  BUY: 'var(--color-buy)',
  NEGOTIATE: 'var(--color-negotiate)',
  WATCH: 'var(--color-watch)',
  AVOID: 'var(--color-avoid)',
  INSUFFICIENT_EVIDENCE: 'var(--color-unknown)',
};

export const HeroVerdictCard = ({ intel }: { intel: PropertyIntelligence }) => {
  const { property, score, decision, valuation, negotiation, locality, freshness } = intel;
  const color = DECISION_COLOR[decision.decision];
  const underpriced = valuation.askingDeviationPercent < 0;

  return (
    <article
      aria-label="A worked example: one property's verdict"
      className="relative overflow-hidden rounded-xl border border-ink-800 bg-ink-900/85 p-5 shadow-2xl backdrop-blur"
    >
      {/* A single hairline in the verdict colour, so the card reads at a glance. */}
      <span aria-hidden className="absolute inset-x-0 top-0 h-px" style={{ background: color }} />

      <div className="flex items-center justify-between gap-3">
        <span
          className="inline-flex items-center gap-2 rounded-md border px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wider"
          style={{
            color,
            borderColor: color,
            background: `color-mix(in srgb, ${color} 15%, transparent)`,
          }}
        >
          {DECISION_LABELS[decision.decision]}
        </span>
        {intel.usesDemoData && (
          <span className="rounded border border-ink-700 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-ink-400">
            Demo data
          </span>
        )}
      </div>

      <div className="mt-4 flex items-start gap-5">
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-semibold leading-snug text-ink-50">{property.title}</h2>
          <p className="mt-1 text-xs text-ink-400">
            {locality?.name ?? 'Unmapped locality'} · {property.areaSqFt} sqft
            {property.carpetAreaSqFt ? ` · ${property.carpetAreaSqFt} sqft carpet` : ''}
          </p>
          <p className="mt-3 text-sm leading-relaxed text-ink-300">{decision.headline}</p>
        </div>

        <ScoreDial
          score={score.score}
          band={score.band}
          confidence={score.confidence}
          size={96}
          className="shrink-0"
        />
      </div>

      <dl className="mt-5 grid grid-cols-3 gap-3 border-t border-ink-800 pt-4">
        <Cell label="Asking" value={formatINR(property.askingPrice)} />
        <Cell
          label="vs fair value"
          value={formatSignedPercent(valuation.askingDeviationPercent)}
          tone={underpriced ? 'var(--color-buy)' : 'var(--color-avoid)'}
        />
        <Cell label="Evidence coverage" value={formatPercent(score.coverage * 100, 0)} />
      </dl>

      {negotiation && (
        <dl className="mt-3 grid grid-cols-3 gap-3 rounded-lg bg-ink-950/60 p-3">
          <Cell label="Open at" value={formatINR(negotiation.openingOffer)} small />
          <Cell label="Target" value={formatINR(negotiation.targetPrice)} small />
          <Cell label="Walk away above" value={formatINR(negotiation.walkAwayPrice)} small />
        </dl>
      )}

      <div className="mt-4 flex flex-wrap items-center justify-between gap-2 text-[11px] text-ink-400">
        <span data-figure>
          {freshness.totalCount} evidence records · {freshness.staleCount} stale
        </span>
        <Link
          href={`/property/${property.id}`}
          className="inline-flex items-center gap-1 font-medium text-accent-400 hover:text-accent-300"
        >
          Open the full workup <ArrowRight aria-hidden className="size-3.5" />
        </Link>
      </div>
    </article>
  );
};

const Cell = ({
  label,
  value,
  tone,
  small = false,
}: {
  label: string;
  value: string;
  tone?: string;
  small?: boolean;
}) => (
  <div>
    <dt className="text-[9.5px] font-semibold uppercase tracking-[0.12em] text-ink-500">{label}</dt>
    <dd
      data-figure
      className={`mt-0.5 font-semibold tracking-tight ${small ? 'text-xs' : 'text-sm'}`}
      style={tone ? { color: tone } : undefined}
    >
      {value}
    </dd>
  </div>
);
