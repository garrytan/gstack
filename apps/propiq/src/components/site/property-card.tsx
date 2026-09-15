/**
 * A property card.
 *
 * Carries the verdict, the score and the two or three signals that actually
 * separate this property from the next one — not an amenity list. The image
 * slot is a generated gradient rather than a photograph: the dataset has no
 * real photography, and a stock image of a building that is not this building
 * is a fabricated fact with a picture frame around it.
 */

import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { DECISION_LABELS } from '@/domain/decision/engine';
import type { Decision } from '@/domain/decision/engine';
import { formatINR, formatPercent, formatPsf } from '@/lib/utils';
import type { SiteProperty } from '@/site/types';

const DECISION_COLOR: Readonly<Record<Decision, string>> = {
  BUY: 'var(--color-buy)',
  NEGOTIATE: 'var(--color-negotiate)',
  WATCH: 'var(--color-watch)',
  AVOID: 'var(--color-avoid)',
  INSUFFICIENT_EVIDENCE: 'var(--color-unknown)',
};

/** A stable, per-property gradient so cards are distinguishable at a glance. */
const artFor = (id: string): string => {
  const hash = [...id].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 360, 7);
  return `linear-gradient(135deg, hsl(${hash} 55% 32%), hsl(${(hash + 48) % 360} 62% 22%))`;
};

export const SitePropertyCard = ({ property }: { property: SiteProperty }) => {
  const colour = DECISION_COLOR[property.decision];
  const under = property.priceDeviationPercent < 0;

  return (
    <article className="group flex flex-col overflow-hidden rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-0)] transition-shadow hover:shadow-[0_18px_44px_-24px_rgba(13,21,36,0.4)]">
      <div className="relative h-40" style={{ background: artFor(property.id) }} aria-hidden>
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_30%_20%,rgba(255,255,255,0.18),transparent_60%)]" />
        <span className="absolute left-3 top-3 rounded-md bg-black/45 px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-white backdrop-blur">
          {property.signal}
        </span>
      </div>

      <div className="flex flex-1 flex-col p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="truncate text-sm font-semibold">{property.name}</h3>
            <p className="mt-0.5 truncate text-xs text-[var(--text-muted)]">
              {property.locality}, {property.city}
              {property.project ? ` · ${property.project}` : ''}
            </p>
          </div>
          {property.propiqScore !== undefined && (
            <div className="shrink-0 text-right">
              <p data-figure className="text-xl font-bold leading-none" style={{ color: colour }}>
                {property.propiqScore.toFixed(0)}
              </p>
              <p className="text-[9px] uppercase tracking-wider text-[var(--text-muted)]">Score</p>
            </div>
          )}
        </div>

        <div className="mt-3 flex items-baseline gap-2">
          <p data-figure className="text-lg font-semibold">
            {formatINR(property.price)}
          </p>
          <p data-figure className="text-xs text-[var(--text-muted)]">
            {formatPsf(property.pricePerSqFt)}
          </p>
        </div>
        <p className="mt-0.5 text-xs text-[var(--text-secondary)]">
          {property.bhk} BHK · {property.sizeSqFt} sqft
          {property.carpetSqFt ? ` · ${property.carpetSqFt} sqft carpet` : ''}
        </p>

        <ul className="mt-3 space-y-1.5 border-t border-[var(--border-subtle)] pt-3">
          <Signal
            label="Verdict"
            value={DECISION_LABELS[property.decision]}
            colour={colour}
          />
          <Signal
            label="vs fair value"
            value={
              property.fairValueMid === undefined
                ? 'Not valued'
                : `${formatPercent(Math.abs(property.priceDeviationPercent), 1)} ${under ? 'under' : 'over'}`
            }
            colour={
              property.fairValueMid === undefined
                ? undefined
                : under
                  ? 'var(--color-buy)'
                  : 'var(--color-avoid)'
            }
          />
          <Signal label="Risk" value={property.riskBand} />
        </ul>

        <Link
          href={`/property/${property.slug}`}
          className="mt-4 inline-flex items-center gap-1 text-sm font-medium text-[var(--color-brand-blue-500)] hover:underline"
        >
          View intelligence
          <ArrowRight
            aria-hidden
            className="size-4 transition-transform group-hover:translate-x-0.5"
          />
        </Link>
      </div>
    </article>
  );
};

const Signal = ({
  label,
  value,
  colour,
}: {
  label: string;
  value: string;
  colour?: string;
}) => (
  <li className="flex items-center justify-between gap-3 text-xs">
    <span className="text-[var(--text-muted)]">{label}</span>
    <span
      data-figure
      className="font-semibold capitalize"
      style={colour ? { color: colour } : undefined}
    >
      {value}
    </span>
  </li>
);
