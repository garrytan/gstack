/**
 * The PropIQ Score dial.
 *
 * Renders the score, its 95% band and its confidence together, because the
 * number on its own would imply a precision the evidence does not support.
 * When the score is withheld, the dial says so rather than showing a zero.
 */

import { cn } from '@/lib/utils';

const bandColor = (score: number): string =>
  score >= 72
    ? 'var(--color-buy)'
    : score >= 55
      ? 'var(--color-watch)'
      : score >= 40
        ? 'var(--color-negotiate)'
        : 'var(--color-avoid)';

export const ScoreDial = ({
  score,
  band,
  confidence,
  size = 132,
  className,
}: {
  score: number | undefined;
  band?: { low: number; high: number };
  confidence: number;
  size?: number;
  className?: string;
}) => {
  const stroke = 10;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const pct = score === undefined ? 0 : score / 100;
  const color = score === undefined ? 'var(--color-unknown)' : bandColor(score);

  return (
    <div className={cn('flex flex-col items-center gap-2', className)}>
      <div className="relative" style={{ width: size, height: size }}>
        <svg
          width={size}
          height={size}
          viewBox={`0 0 ${size} ${size}`}
          role="img"
          aria-label={
            score === undefined
              ? 'PropIQ Score not published: insufficient evidence'
              : `PropIQ Score ${score} out of 100${band ? `, 95% band ${band.low} to ${band.high}` : ''}`
          }
        >
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            stroke="var(--border-subtle)"
            strokeWidth={stroke}
          />
          {score !== undefined && (
            <circle
              cx={size / 2}
              cy={size / 2}
              r={radius}
              fill="none"
              stroke={color}
              strokeWidth={stroke}
              strokeLinecap="round"
              strokeDasharray={circumference}
              strokeDashoffset={circumference * (1 - pct)}
              transform={`rotate(-90 ${size / 2} ${size / 2})`}
            />
          )}
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          {score === undefined ? (
            <span className="px-3 text-center text-xs font-medium text-[var(--text-muted)]">
              Not enough evidence
            </span>
          ) : (
            <>
              <span data-figure className="text-3xl font-semibold leading-none" style={{ color }}>
                {Math.round(score)}
              </span>
              <span className="mt-1 text-[10px] uppercase tracking-wider text-[var(--text-muted)]">
                PropIQ Score
              </span>
            </>
          )}
        </div>
      </div>
      {score !== undefined && band && (
        <p data-figure className="text-[11px] text-[var(--text-muted)]">
          95% band {band.low}–{band.high} · {Math.round(confidence * 100)}% confidence
        </p>
      )}
    </div>
  );
};
