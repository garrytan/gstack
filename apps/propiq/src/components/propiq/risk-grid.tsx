/**
 * Risk grid.
 *
 * Nine named dimensions, each with its own band and its own drivers. There is
 * deliberately no single red/green summary badge: the product's position is
 * that "medium risk" tells a buyer nothing they can act on.
 */

import type { RiskAssessment, RiskBand } from '@/domain/risk/types';

const BAND_COLOR: Readonly<Record<RiskBand, string>> = {
  low: 'var(--color-buy)',
  moderate: 'var(--color-watch)',
  elevated: 'var(--color-negotiate)',
  high: 'var(--color-avoid)',
  unknown: 'var(--color-unknown)',
};

const BAND_LABEL: Readonly<Record<RiskBand, string>> = {
  low: 'Low',
  moderate: 'Moderate',
  elevated: 'Elevated',
  high: 'High',
  unknown: 'Unknown',
};

export const RiskGrid = ({ risk }: { risk: RiskAssessment }) => (
  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
    {risk.dimensions.map((d) => (
      <article key={d.dimension} className="rounded-lg propiq-card p-3">
        <header className="flex items-start justify-between gap-2">
          <h3 className="text-xs font-semibold">{d.label}</h3>
          <span
            className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide"
            style={{
              color: BAND_COLOR[d.band],
              background: `color-mix(in srgb, ${BAND_COLOR[d.band]} 7%, transparent)`,
            }}
          >
            {BAND_LABEL[d.band]}
          </span>
        </header>

        <div
          className="mt-2 h-1.5 overflow-hidden rounded-full bg-[var(--surface-2)]"
          role="img"
          aria-label={`${d.label}: ${BAND_LABEL[d.band]}${d.hasData ? `, severity ${d.severity.toFixed(2)} of 1` : ''}`}
        >
          {d.hasData && (
            <span
              className="block h-full rounded-full"
              style={{ width: `${d.severity * 100}%`, background: BAND_COLOR[d.band] }}
            />
          )}
        </div>

        <ul className="mt-2 space-y-1">
          {d.drivers.map((driver) => (
            <li key={driver} className="text-[11px] leading-snug text-[var(--text-secondary)]">
              {driver}
            </li>
          ))}
        </ul>

        {!d.hasData && (
          <p className="mt-2 text-[11px] text-[var(--text-muted)]">
            Excluded from the composite. We do not score an unknown as safe.
          </p>
        )}
      </article>
    ))}
  </div>
);
