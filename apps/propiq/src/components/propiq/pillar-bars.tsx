/**
 * Pillar breakdown.
 *
 * Every pillar expands into the signals behind it, with the raw observed value
 * and the normalization method. This is the "no black-box scoring" commitment
 * rendered: a user can walk from the composite down to "18 months of delay".
 */

'use client';

import { useState } from 'react';
import { ChevronRight } from 'lucide-react';
import type { PillarScore } from '@/domain/scoring/types';
import { cn } from '@/lib/utils';

const barColor = (score: number): string =>
  score >= 72
    ? 'var(--color-buy)'
    : score >= 55
      ? 'var(--color-watch)'
      : score >= 40
        ? 'var(--color-negotiate)'
        : 'var(--color-avoid)';

const PillarRow = ({ pillar, weight }: { pillar: PillarScore; weight?: number }) => {
  const [open, setOpen] = useState(false);
  const scored = pillar.score !== undefined;

  return (
    <li className="border-b border-[var(--border-subtle)] last:border-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-3 py-2.5 text-left"
      >
        <ChevronRight
          aria-hidden
          className={cn(
            'size-3.5 shrink-0 text-[var(--text-muted)] transition-transform',
            open && 'rotate-90',
          )}
        />
        <span className="w-36 shrink-0 truncate text-xs font-medium sm:w-44">{pillar.label}</span>
        <span className="h-2 flex-1 overflow-hidden rounded-full bg-[var(--surface-2)]">
          {scored && (
            <span
              className="block h-full rounded-full"
              style={{ width: `${pillar.score}%`, background: barColor(pillar.score!) }}
            />
          )}
        </span>
        <span
          data-figure
          className={cn(
            'w-10 shrink-0 text-right text-xs font-semibold',
            !scored && 'text-[var(--text-muted)]',
          )}
        >
          {scored ? Math.round(pillar.score!) : '—'}
        </span>
        {weight !== undefined && (
          <span
            data-figure
            className="hidden w-10 shrink-0 text-right text-[10px] text-[var(--text-muted)] sm:block"
          >
            {Math.round(weight * 100)}%
          </span>
        )}
      </button>

      {open && (
        <div className="pb-3 pl-7 pr-1">
          {!scored && (
            <p className="mb-2 text-[11px] text-[var(--text-muted)]">
              No signal in this pillar had usable evidence, so it was excluded and the remaining
              pillar weights were rescaled. It is not scored as zero.
            </p>
          )}
          <p className="mb-2 text-[11px] text-[var(--text-muted)]">
            Coverage {Math.round(pillar.coverage * 100)}% · confidence{' '}
            {Math.round(pillar.confidence * 100)}%
          </p>
          <table className="w-full text-[11px]">
            <thead>
              <tr className="text-left text-[var(--text-muted)]">
                <th scope="col" className="pb-1 font-normal">
                  Signal
                </th>
                <th scope="col" className="pb-1 font-normal">
                  Observed
                </th>
                <th scope="col" className="pb-1 text-right font-normal">
                  Normalised
                </th>
                <th scope="col" className="pb-1 text-right font-normal">
                  Weight
                </th>
              </tr>
            </thead>
            <tbody>
              {pillar.signals.map((s) => (
                <tr key={s.key} className="align-top">
                  <td className="py-1 pr-2">
                    <span className="font-medium text-[var(--text-secondary)]">{s.label}</span>
                    <span className="block text-[10px] text-[var(--text-muted)]">
                      {s.methodology}
                    </span>
                  </td>
                  <td data-figure className="py-1 pr-2 text-[var(--text-secondary)]">
                    {s.raw === undefined ? (
                      <span className="text-[var(--text-muted)]">no data</span>
                    ) : (
                      `${s.raw}${s.unit ? ` ${s.unit}` : ''}`
                    )}
                  </td>
                  <td data-figure className="py-1 pr-2 text-right">
                    {s.normalized === undefined ? '—' : s.normalized.toFixed(2)}
                  </td>
                  <td data-figure className="py-1 text-right text-[var(--text-muted)]">
                    {Math.round(s.weight * 100)}%
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </li>
  );
};

export const PillarBars = ({
  pillars,
  weights,
}: {
  pillars: readonly PillarScore[];
  weights?: Readonly<Partial<Record<string, number>>>;
}) => (
  <ul>
    {pillars.map((p) => (
      <PillarRow key={p.pillar} pillar={p} weight={weights?.[p.pillar]} />
    ))}
  </ul>
);
