'use client';

/**
 * Locality price comparison.
 *
 * A bar per locality on the one figure that compares across them, with the
 * subject locality emphasised. Every chart in this product ships with the
 * same numbers in text underneath, so the information survives without the
 * picture — for a screen reader, for a printout, and for anyone who would
 * rather read a figure than estimate it off an axis.
 */

import { Bar, BarChart, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { SiteLocality } from '@/site/types';

export const LocalityPriceChart = ({
  localities,
  highlight,
}: {
  localities: readonly SiteLocality[];
  highlight: string | undefined;
}) => {
  const data = localities
    .filter((l) => l.medianPricePerSqFt !== undefined)
    .map((l) => ({
      name: l.name,
      psf: l.medianPricePerSqFt ?? 0,
      subject: l.slug === highlight,
    }))
    .sort((a, b) => b.psf - a.psf);

  if (data.length < 2) {
    return (
      <p className="rounded-lg border border-dashed border-[var(--border-strong)] p-6 text-center text-xs text-[var(--text-muted)]">
        Not enough localities with a recorded median to compare.
      </p>
    );
  }

  return (
    <figure className="m-0">
      <div className="h-60 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 8, right: 8, bottom: 4, left: 8 }}>
            <XAxis
              dataKey="name"
              tick={{ fontSize: 10, fill: 'var(--text-muted)' }}
              stroke="var(--border-strong)"
              interval={0}
              angle={-18}
              textAnchor="end"
              height={54}
            />
            <YAxis
              tick={{ fontSize: 10, fill: 'var(--text-muted)' }}
              stroke="var(--border-strong)"
              width={58}
              tickFormatter={(v: number) => `₹${(v / 1000).toFixed(0)}k`}
            />
            <Tooltip
              cursor={{ fill: 'var(--surface-2)' }}
              contentStyle={{
                background: 'var(--surface-0)',
                border: '1px solid var(--border-subtle)',
                borderRadius: 8,
                fontSize: 12,
              }}
              formatter={(v) => [`₹${Number(v ?? 0).toLocaleString('en-IN')}/sqft`, 'Median']}
            />
            <Bar dataKey="psf" radius={[4, 4, 0, 0]}>
              {data.map((d) => (
                <Cell
                  key={d.name}
                  fill={d.subject ? 'var(--color-brand-blue-500)' : 'var(--surface-2)'}
                />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
      <figcaption className="mt-2 text-[11px] leading-relaxed text-[var(--text-muted)]">
        Median price per square foot by locality:{' '}
        {data.map((d, i) => (
          <span key={d.name}>
            {i > 0 ? ', ' : ''}
            {d.name} ₹{d.psf.toLocaleString('en-IN')}
            {d.subject ? ' (this locality)' : ''}
          </span>
        ))}
        .
      </figcaption>
    </figure>
  );
};
