'use client';

import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { PricePoint } from '@/domain/locality/types';

/**
 * Price trend.
 *
 * Every chart in PropIQ ships with a textual summary underneath it, so the
 * information is available to a screen reader and to anyone who would rather
 * read the number than squint at a line.
 */
export const PriceHistoryChart = ({ history }: { history: readonly PricePoint[] }) => {
  if (history.length < 2) {
    return (
      <p className="rounded-lg border border-dashed border-[var(--border-strong)] p-6 text-center text-xs text-[var(--text-muted)]">
        Not enough price history to draw a trend.
      </p>
    );
  }

  const first = history[0]!;
  const last = history[history.length - 1]!;
  const changePct =
    ((last.medianPricePerSqFt - first.medianPricePerSqFt) / first.medianPricePerSqFt) * 100;

  return (
    <figure>
      <div className="h-56 w-full rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-1)] p-3">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={[...history]} margin={{ top: 4, right: 8, bottom: 4, left: 8 }}>
            <CartesianGrid stroke="var(--border-subtle)" strokeDasharray="3 3" vertical={false} />
            <XAxis
              dataKey="period"
              tick={{ fontSize: 10, fill: 'var(--text-muted)' }}
              stroke="var(--border-strong)"
              interval="preserveStartEnd"
            />
            <YAxis
              tick={{ fontSize: 10, fill: 'var(--text-muted)' }}
              stroke="var(--border-strong)"
              width={52}
              tickFormatter={(v: number) => `₹${(v / 1000).toFixed(1)}k`}
            />
            <Tooltip
              contentStyle={{
                background: 'var(--surface-2)',
                border: '1px solid var(--border-strong)',
                borderRadius: 6,
                fontSize: 12,
              }}
              formatter={(v) => [`₹${Number(v ?? 0).toLocaleString('en-IN')}/sqft`, 'Median']}
            />
            <Line
              type="monotone"
              dataKey="medianPricePerSqFt"
              stroke="var(--color-accent-500)"
              strokeWidth={2}
              dot={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
      <figcaption data-figure className="mt-2 text-xs text-[var(--text-secondary)]">
        Median asking price moved from ₹{first.medianPricePerSqFt.toLocaleString('en-IN')}/sqft in{' '}
        {first.period} to ₹{last.medianPricePerSqFt.toLocaleString('en-IN')}/sqft in {last.period},
        a change of {changePct >= 0 ? '+' : ''}
        {changePct.toFixed(1)}% across {history.length} observations.
      </figcaption>
    </figure>
  );
};
