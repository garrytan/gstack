/**
 * Fair-value band.
 *
 * Draws the asking price against the estimated range so the gap is the first
 * thing a buyer sees. When there are too few comparables we show the reason,
 * not a number — a fabricated central estimate is worse than no estimate.
 */

import type { Valuation } from '@/domain/valuation/types';
import type { NegotiationGuidance } from '@/domain/valuation/types';
import { DataStatusBadge } from './data-status';
import { formatINR, formatPsf, formatSignedPercent } from '@/lib/utils';

export const ValuationBand = ({
  valuation,
  negotiation,
}: {
  valuation: Valuation;
  negotiation?: NegotiationGuidance;
}) => {
  if (valuation.insufficientEvidence) {
    return (
      <div className="rounded-lg propiq-card p-4">
        <h3 className="text-sm font-semibold">Fair value unavailable</h3>
        <p className="mt-1 text-sm text-[var(--text-secondary)]">{valuation.adjustmentNotes[0]}</p>
        <p className="mt-2 text-xs text-[var(--text-muted)]">
          We would rather show you nothing than a number we cannot defend. Asking price is{' '}
          <span data-figure>{formatINR(valuation.askingPrice)}</span>.
        </p>
      </div>
    );
  }

  // Draw the asking price on the same axis as the band, with 12% headroom
  // either side so an asking price outside the range is still visible.
  const span = valuation.high - valuation.low;
  const axisLow = valuation.low - span * 0.5;
  const axisHigh = valuation.high + span * 0.5;
  const axisSpan = axisHigh - axisLow || 1;
  const pos = (v: number) => `${Math.max(0, Math.min(100, ((v - axisLow) / axisSpan) * 100))}%`;
  const above = valuation.askingDeviationPercent > 0;

  return (
    <div className="rounded-lg propiq-card p-4">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">Fair value &amp; negotiation</h3>
        <div className="flex items-center gap-2">
          <DataStatusBadge status={valuation.dataStatus} />
          <span className="text-[11px] text-[var(--text-muted)]">
            {Math.round(valuation.confidence * 100)}% confidence
          </span>
        </div>
      </header>

      <div className="mt-5 pb-2">
        <div className="relative h-2 rounded-full bg-[var(--surface-2)]">
          <span
            className="absolute inset-y-0 rounded-full bg-accent-600/50"
            style={{ left: pos(valuation.low), right: `calc(100% - ${pos(valuation.high)})` }}
          />
          <span
            className="absolute top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent-400"
            style={{ left: pos(valuation.mid) }}
            title="Central estimate"
          />
          <span
            className="absolute -top-1 h-4 w-0.5 -translate-x-1/2"
            style={{
              left: pos(valuation.askingPrice),
              background: above ? 'var(--color-avoid)' : 'var(--color-buy)',
            }}
            title="Asking price"
          />
        </div>
        <div className="mt-2 flex justify-between text-[11px] text-[var(--text-muted)]">
          <span data-figure>{formatINR(valuation.low)}</span>
          <span data-figure>Central {formatINR(valuation.mid)}</span>
          <span data-figure>{formatINR(valuation.high)}</span>
        </div>
      </div>

      <dl className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Asking price" value={formatINR(valuation.askingPrice)} />
        <Stat
          label="vs fair value"
          value={formatSignedPercent(valuation.askingDeviationPercent)}
          tone={above ? 'bad' : 'good'}
        />
        <Stat label="Central ₹/sqft" value={formatPsf(valuation.perSqFtMid)} />
        <Stat label="Newest comparable" value={`${valuation.freshnessDays} days old`} />
      </dl>

      {negotiation && (
        <div className="mt-4 rounded-md propiq-card p-3">
          <p className="text-xs font-semibold">Where to open, where to stop</p>
          <dl className="mt-2 grid grid-cols-3 gap-2">
            <Stat label="Open at" value={formatINR(negotiation.openingOffer)} />
            <Stat label="Target" value={formatINR(negotiation.targetPrice)} />
            <Stat label="Walk away above" value={formatINR(negotiation.walkAwayPrice)} />
          </dl>
          {negotiation.leverPoints.length > 0 && (
            <ul className="mt-3 space-y-1">
              {negotiation.leverPoints.map((l) => (
                <li key={l} className="text-[11px] text-[var(--text-secondary)]">
                  • {l}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <ul className="mt-3 space-y-0.5">
        {valuation.adjustmentNotes.map((n) => (
          <li key={n} className="text-[11px] text-[var(--text-muted)]">
            {n}
          </li>
        ))}
      </ul>
    </div>
  );
};

const Stat = ({ label, value, tone }: { label: string; value: string; tone?: 'good' | 'bad' }) => (
  <div>
    <dt className="text-[10px] uppercase tracking-wide text-[var(--text-muted)]">{label}</dt>
    <dd
      data-figure
      className="text-sm font-semibold"
      style={
        tone === 'bad'
          ? { color: 'var(--color-avoid)' }
          : tone === 'good'
            ? { color: 'var(--color-buy)' }
            : undefined
      }
    >
      {value}
    </dd>
  </div>
);
