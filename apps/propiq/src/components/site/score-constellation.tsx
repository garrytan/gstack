'use client';

/**
 * The PropIQ Score, as a constellation.
 *
 * A ring gauge says one thing: how far round the number got. This score is
 * twelve weighted pillars, each with its own evidence coverage and its own
 * confidence, and a single arc throws all of that away — which is the opposite
 * of what a published-formula product should be showing.
 *
 * So the composite sits at the centre and the twelve pillars orbit it. Each
 * node's distance from the centre is its score, its size is the weight it
 * carries in the composite, and its fill is the sequential ramp — three
 * channels, three facts, none of them decorative. A pillar the engine withheld
 * is drawn as an open ring on the outer track: present, unscored, and visibly
 * not zero. Selecting one opens what is behind it.
 *
 * It is a diagram, not a control surface, so it is not the only way to read
 * this. The same numbers are in the table below it, which is what a keyboard,
 * a screen reader and a printout all get — and the nodes are real buttons in
 * document order, so arrow-free tabbing works.
 */

import { useState } from 'react';
import { ArrowRight, Info } from 'lucide-react';
import Link from 'next/link';
import { scoreRampFill } from '@/components/propiq/score-ramp';
import { formatPercent } from '@/lib/utils';
import { cn } from '@/lib/utils';
import type { SiteScoreBreakdown } from '@/site/types';

/** Geometry of the ring, in the SVG's own units. */
const SIZE = 460;
const CENTRE = SIZE / 2;
const INNER = 92;
const OUTER = 200;

/**
 * The drawing is square; the labelled drawing is not. A label anchored at the
 * three o'clock track starts at x=452 and "Developer track record" runs about
 * 130 units past that, so a 0 0 460 460 box cuts the labels off on both sides.
 * The box is widened rather than the labels moved inward, because pulling them
 * in is what makes them collide with the nodes.
 */
const VIEW = { x: -132, y: -18, w: 724, h: 496 } as const;

/** Where a score sits on the radius. Withheld pillars go to the outer track. */
const radiusFor = (score: number | undefined): number =>
  score === undefined ? OUTER : INNER + ((OUTER - INNER) * Math.max(0, Math.min(100, score))) / 100;

/** Node radius from pillar weight, so the heavy pillars read as heavy. */
const sizeFor = (weight: number | undefined): number =>
  weight === undefined ? 6.5 : 6.5 + Math.min(1, weight / 0.16) * 8;

export const ScoreConstellation = ({
  score,
  band,
  confidence,
  coverage,
  breakdown,
  propertyName,
  locality,
}: {
  score: number | undefined;
  band: { readonly low: number; readonly high: number } | undefined;
  confidence: number;
  coverage: number;
  breakdown: readonly SiteScoreBreakdown[];
  propertyName: string;
  locality: string;
}) => {
  const [selected, setSelected] = useState<string | undefined>(undefined);
  const active = breakdown.find((p) => p.key === selected);
  const withheld = breakdown.filter((p) => p.score === undefined).length;

  /* Coordinates are rounded before they reach an attribute. `Math.cos(-PI/2)`
     is 6.1e-17, not 0, so an unrounded centre serialises as
     `230.00000000000003` — noise in the markup, and the kind of value that
     makes a server and a client render disagree over nothing. */
  const at = (n: number): number => Math.round(n * 100) / 100;

  const placed = breakdown.map((p, i) => {
    // Start at twelve o'clock and go clockwise, so the reading order on screen
    // matches the reading order in the list underneath.
    const angle = (i / breakdown.length) * Math.PI * 2 - Math.PI / 2;
    const r = radiusFor(p.score);
    return {
      ...p,
      x: at(CENTRE + Math.cos(angle) * r),
      y: at(CENTRE + Math.sin(angle) * r),
      // The label rides the outer track whatever the score, or the labels
      // collide wherever two pillars happen to score alike.
      lx: at(CENTRE + Math.cos(angle) * (OUTER + 26)),
      ly: at(CENTRE + Math.sin(angle) * (OUTER + 26)),
      anchor: (Math.cos(angle) > 0.25 ? 'start' : Math.cos(angle) < -0.25 ? 'end' : 'middle') as
        'start' | 'end' | 'middle',
      r: at(sizeFor(p.weight)),
    };
  });

  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,20rem)] lg:gap-10">
      {/* ------------------------------------------------------- the diagram */}
      <div className="relative mx-auto w-full">
        <svg
          viewBox={`${VIEW.x} ${VIEW.y} ${VIEW.w} ${VIEW.h}`}
          className="w-full"
          role="img"
          aria-label={
            score === undefined
              ? `PropIQ Score withheld: evidence coverage ${formatPercent(coverage * 100, 0)} is below the reporting floor`
              : `PropIQ Score ${Math.round(score)} out of 100 across ${breakdown.length} pillars${
                  band ? `, 95% band ${band.low} to ${band.high}` : ''
                }. Each pillar's score is listed below.`
          }
        >
          {/* The scale. Three rings at 25 / 50 / 75 so a node's distance from
              the centre can be read as a number, not just compared. */}
          {[25, 50, 75, 100].map((tick) => (
            <circle
              key={tick}
              cx={CENTRE}
              cy={CENTRE}
              r={at(radiusFor(tick))}
              fill="none"
              stroke="var(--border-subtle)"
              strokeWidth="1"
              strokeDasharray={tick === 100 ? undefined : '2 5'}
            />
          ))}

          {/* Spokes from the composite to each pillar: the composite IS the
              weighted sum of these, and the line is that sentence drawn. */}
          {placed.map((p) => (
            <line
              key={`spoke-${p.key}`}
              x1={CENTRE}
              y1={CENTRE}
              x2={p.x}
              y2={p.y}
              stroke="var(--border-subtle)"
              strokeWidth={p.key === selected ? 1.6 : 0.8}
              opacity={selected === undefined || p.key === selected ? 0.8 : 0.28}
            />
          ))}

          {placed.map((p) => {
            const dim = selected !== undefined && p.key !== selected;
            return (
              <g key={p.key} opacity={dim ? 0.32 : 1}>
                <text
                  x={p.lx}
                  y={p.ly}
                  textAnchor={p.anchor}
                  dominantBaseline="middle"
                  className="propiq-constellation-label"
                >
                  {p.label}
                </text>
                {p.score === undefined ? (
                  <circle
                    cx={p.x}
                    cy={p.y}
                    r={p.r}
                    fill="none"
                    stroke="var(--color-unknown)"
                    strokeWidth="1.5"
                    strokeDasharray="3 3"
                  />
                ) : (
                  <circle
                    cx={p.x}
                    cy={p.y}
                    r={p.r}
                    fill={scoreRampFill(p.score)}
                    stroke="var(--surface-0)"
                    strokeWidth="2"
                  />
                )}
              </g>
            );
          })}

          {/* The composite. */}
          <circle
            cx={CENTRE}
            cy={CENTRE}
            r={INNER - 16}
            fill="var(--surface-card)"
            stroke="var(--border-strong)"
          />
          <text
            x={CENTRE}
            y={CENTRE - 6}
            textAnchor="middle"
            className="propiq-constellation-score"
          >
            {score === undefined ? '—' : Math.round(score)}
          </text>
          <text x={CENTRE} y={CENTRE + 20} textAnchor="middle" className="propiq-constellation-cap">
            {band ? `95% band ${band.low}–${band.high}` : 'Not enough evidence'}
          </text>
        </svg>

        {/* Real buttons, positioned over the diagram. A <circle> with an
            onClick is invisible to a keyboard; a button is not. */}
        {placed.map((p) => (
          <button
            key={`hit-${p.key}`}
            type="button"
            onClick={() => setSelected((s) => (s === p.key ? undefined : p.key))}
            aria-pressed={p.key === selected}
            className="propiq-constellation-hit"
            style={{
              left: `${((p.x - VIEW.x) / VIEW.w) * 100}%`,
              top: `${((p.y - VIEW.y) / VIEW.h) * 100}%`,
            }}
          >
            <span className="sr-only">
              {p.label}: {p.score === undefined ? 'withheld, no evidence' : Math.round(p.score)}
            </span>
          </button>
        ))}
      </div>

      {/* --------------------------------------------------------- the panel */}
      <div className="lg:pt-4">
        {active === undefined ? (
          <>
            <p className="text-lg font-semibold">
              {propertyName}
              <span className="ml-2 font-normal text-[var(--text-muted)]">{locality}</span>
            </p>
            <p className="mt-3 text-sm leading-relaxed text-[var(--text-secondary)]">
              Distance from the centre is the pillar&rsquo;s score. Size is the weight it carries in
              the composite. A dashed ring is a pillar the engine withheld — no evidence, so its
              weight was redistributed rather than scored as zero.
            </p>
            <dl className="mt-6 grid grid-cols-2 gap-5">
              <div>
                <dt className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--text-muted)]">
                  Evidence coverage
                </dt>
                <dd data-figure className="mt-1 text-2xl font-semibold">
                  {formatPercent(coverage * 100, 0)}
                </dd>
              </div>
              <div>
                <dt className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--text-muted)]">
                  Confidence
                </dt>
                <dd data-figure className="mt-1 text-2xl font-semibold">
                  {formatPercent(confidence * 100, 0)}
                </dd>
              </div>
              <div>
                <dt className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--text-muted)]">
                  Pillars scored
                </dt>
                <dd data-figure className="mt-1 text-2xl font-semibold">
                  {breakdown.length - withheld} / {breakdown.length}
                </dd>
              </div>
              <div>
                <dt className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--text-muted)]">
                  Withheld
                </dt>
                <dd data-figure className="mt-1 text-2xl font-semibold">
                  {withheld}
                </dd>
              </div>
            </dl>
            <p className="mt-6 flex items-start gap-2 text-[13px] text-[var(--text-muted)]">
              <Info aria-hidden className="mt-0.5 size-3.5 shrink-0" />
              Select any pillar to see its weight, its coverage and what moved it.
            </p>
          </>
        ) : (
          <div className="propiq-card rounded-xl p-5">
            <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--text-muted)]">
              Pillar
            </p>
            <p className="mt-1 text-lg font-semibold">{active.label}</p>

            <div className="mt-4 flex items-baseline gap-4 border-y border-[var(--border-subtle)] py-4">
              <span data-figure className="text-4xl font-semibold leading-none">
                {active.score === undefined ? '—' : Math.round(active.score)}
              </span>
              <span className="text-sm text-[var(--text-secondary)]">
                {active.weight === undefined
                  ? 'weight unavailable'
                  : `${formatPercent(active.weight * 100, 0)} of the composite`}
              </span>
            </div>

            <dl className="mt-4 space-y-2.5 text-[13px]">
              <div className="flex justify-between gap-4">
                <dt className="text-[var(--text-muted)]">Evidence coverage</dt>
                <dd data-figure className="font-medium">
                  {formatPercent(active.coverage * 100, 0)}
                </dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-[var(--text-muted)]">Confidence</dt>
                <dd data-figure className="font-medium">
                  {formatPercent(active.confidence * 100, 0)}
                </dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-[var(--text-muted)]">Signals with data</dt>
                <dd data-figure className="font-medium">
                  {active.signalsWithData} of {active.signalCount}
                </dd>
              </div>
            </dl>

            {active.drivers.length > 0 ? (
              <>
                <p className="mt-5 text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--text-muted)]">
                  What moved it
                </p>
                <ul className="mt-2 space-y-1.5">
                  {active.drivers.map((d) => (
                    <li key={d} className="text-[13px] leading-snug text-[var(--text-secondary)]">
                      {d}
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <p className="mt-5 text-[13px] leading-relaxed text-[var(--text-muted)]">
                No signal in this pillar had usable evidence, so it was excluded and the remaining
                weights were rescaled. It is not scored as zero.
              </p>
            )}

            <div className="mt-5 flex items-center gap-4">
              <button
                type="button"
                onClick={() => setSelected(undefined)}
                className="text-[13px] font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
              >
                Clear
              </button>
              <Link
                href="/methodology"
                className="inline-flex items-center gap-1 text-[13px] font-medium text-[var(--text-accent)] hover:underline"
              >
                How this is weighted <ArrowRight aria-hidden className="size-3.5" />
              </Link>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

/** The same numbers as a list. Always rendered; never the fallback. */
export const ConstellationTable = ({
  breakdown,
  className,
}: {
  breakdown: readonly SiteScoreBreakdown[];
  className?: string;
}) => (
  <div className={cn('overflow-x-auto', className)}>
    <table className="w-full min-w-[34rem] text-sm">
      <caption className="sr-only">
        Every scoring pillar with its score, its weight in the composite and its evidence coverage.
      </caption>
      <thead>
        <tr className="border-b border-[var(--border-subtle)] text-left text-[var(--text-muted)]">
          <th scope="col" className="py-2 pr-3 text-[11px] font-medium uppercase tracking-wider">
            Pillar
          </th>
          <th
            scope="col"
            className="py-2 pr-3 text-right text-[11px] font-medium uppercase tracking-wider"
          >
            Score
          </th>
          <th
            scope="col"
            className="py-2 pr-3 text-right text-[11px] font-medium uppercase tracking-wider"
          >
            Weight
          </th>
          <th
            scope="col"
            className="py-2 text-right text-[11px] font-medium uppercase tracking-wider"
          >
            Coverage
          </th>
        </tr>
      </thead>
      <tbody>
        {breakdown.map((p) => (
          <tr key={p.key} className="border-b border-[var(--border-subtle)] last:border-0">
            <th scope="row" className="py-2 pr-3 text-left font-normal">
              {p.label}
            </th>
            <td data-figure className="py-2 pr-3 text-right font-semibold">
              {p.score === undefined ? (
                <span className="font-normal text-[var(--text-muted)]">withheld</span>
              ) : (
                Math.round(p.score)
              )}
            </td>
            <td data-figure className="py-2 pr-3 text-right text-[var(--text-secondary)]">
              {p.weight === undefined ? '—' : formatPercent(p.weight * 100, 0)}
            </td>
            <td data-figure className="py-2 text-right text-[var(--text-secondary)]">
              {formatPercent(p.coverage * 100, 0)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  </div>
);
