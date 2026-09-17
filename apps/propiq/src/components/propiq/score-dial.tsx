/**
 * The PropIQ Score dial.
 *
 * Renders the score, its 95% band and its confidence together, because the
 * number on its own would imply a precision the evidence does not support.
 * When the score is withheld, the dial says so rather than showing a zero.
 */

import type { Decision } from '@/domain/decision/engine';
import { DECISION_LABELS } from '@/domain/decision/engine';
import { DECISION_COLOUR } from '@/components/propiq/decision-colour';
import { cn } from '@/lib/utils';

/** The size the type was drawn against. Everything scales from here. */
const REFERENCE_SIZE = 132;

/**
 * Type inside the ring, scaled to the ring.
 *
 * The number and the caption were fixed at 30px and 10px, which is right at
 * the default size and overflows the ring at anything smaller — the caption
 * is wider than the inner diameter below about 110px. Scaling keeps the dial
 * usable at any size, and the caption is dropped rather than clipped once
 * there is no room for it.
 */
export const dialTypography = (
  size: number,
): { scoreFontPx: number; labelFontPx: number; showLabel: boolean } => {
  const ratio = size / REFERENCE_SIZE;
  return {
    scoreFontPx: Math.round(30 * ratio),
    labelFontPx: Math.max(8, Math.round(10 * ratio)),
    showLabel: size >= 110,
  };
};

export const ScoreDial = ({
  score,
  band,
  confidence,
  decision,
  size = 132,
  className,
}: {
  score: number | undefined;
  band?: { low: number; high: number };
  confidence: number;
  /**
   * The verdict the engine actually reached. The ring used to pick a verdict
   * colour off the score with its own thresholds, which is not how
   * `decideProperty` works — it weighs risk severity and the price gap too, so
   * the ring could read BUY-green beside a badge saying NEGOTIATE. Without a
   * decision to show, the ring is brand-coloured and claims nothing.
   */
  decision?: Decision;
  size?: number;
  className?: string;
}) => {
  const stroke = 10;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const pct = score === undefined ? 0 : score / 100;
  /* The ring is a fill and the number is text, so they take different tokens
     even when they carry the same verdict: the verdict set is already cut into
     a bright half and an ink half per ground, and the brand accent's text
     equivalent is `--text-accent`. */
  const ringColor =
    score === undefined
      ? 'var(--color-unknown)'
      : decision !== undefined
        ? DECISION_COLOUR[decision]
        : 'var(--color-accent-500)';
  const figureColor =
    score === undefined
      ? 'var(--color-unknown)'
      : decision !== undefined
        ? DECISION_COLOUR[decision]
        : 'var(--text-accent)';
  const type = dialTypography(size);

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
              : `PropIQ Score ${score} out of 100${band ? `, 95% band ${band.low} to ${band.high}` : ''}${
                  decision ? `, verdict ${DECISION_LABELS[decision]}` : ''
                }`
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
              stroke={ringColor}
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
            <span
              className="px-3 text-center font-medium leading-tight text-[var(--text-muted)]"
              style={{ fontSize: `${Math.max(9, Math.round(12 * (size / REFERENCE_SIZE)))}px` }}
            >
              Not enough evidence
            </span>
          ) : (
            <>
              <span
                data-figure
                className="font-semibold leading-none"
                style={{ color: figureColor, fontSize: `${type.scoreFontPx}px` }}
              >
                {Math.round(score)}
              </span>
              {type.showLabel && (
                <span
                  className="mt-1 uppercase tracking-wider text-[var(--text-muted)]"
                  style={{ fontSize: `${type.labelFontPx}px` }}
                >
                  PropIQ Score
                </span>
              )}
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
