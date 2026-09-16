/**
 * The score mark and the ramp behind it.
 *
 * A pillar score is a magnitude. It was being painted with the verdict palette
 * — buy / watch / negotiate / avoid — which implied a per-pillar
 * recommendation the engine never computes. There is one verdict per property,
 * it is composite-level, and `decideProperty` reaches it from the score *and*
 * risk severity *and* the price gap, so a pillar could sit green under an
 * AVOID. Painting a magnitude in status colours also spends the one channel
 * that is reserved for state on re-encoding what the bar's length already
 * shows.
 *
 * So: one hue, five even lightness steps, light to dark. The status palette
 * stays reserved for the decision that actually exists, and the number beside
 * every bar means colour is never the only carrier.
 */

import { cn } from '@/lib/utils';

/** Steps in the ramp. The CSS tokens are `--seq-score-1` … `--seq-score-N`. */
export const SCORE_RAMP_STEPS = 5;

/** The band edges the ramp steps at, for the key and for tests. */
export const SCORE_RAMP_EDGES: readonly number[] = Array.from(
  { length: SCORE_RAMP_STEPS },
  (_, i) => ((i + 1) * 100) / SCORE_RAMP_STEPS,
);

/**
 * Which ramp step a score lands on. Clamped at both ends: the engine reports
 * 0–100, but a step index outside the ramp would silently resolve to an
 * undefined custom property and paint nothing.
 */
export const scoreRampStep = (score: number): number =>
  Math.min(SCORE_RAMP_STEPS, Math.max(1, Math.ceil((score / 100) * SCORE_RAMP_STEPS) || 1));

export const scoreRampFill = (score: number): string => `var(--seq-score-${scoreRampStep(score)})`;

/**
 * One pillar bar.
 *
 * `score` is `undefined` when the pillar had no usable evidence. That renders
 * as an empty track, never as a zero-length bar dressed up as a low score —
 * the engine drops the pillar and rescales the rest, and a zero here would
 * misreport that as a bad result.
 */
export const ScoreBar = ({
  score,
  className,
  label,
}: {
  score: number | undefined;
  className?: string;
  /** Set only when the bar stands alone. Beside a printed number, leave it. */
  label?: string;
}) => (
  <span
    className={cn('propiq-scorebar h-2.5', className)}
    {...(label !== undefined
      ? {
          role: 'img',
          'aria-label':
            score === undefined
              ? `${label}: withheld, no evidence`
              : `${label}: ${Math.round(score)} out of 100`,
        }
      : {})}
  >
    {score !== undefined && (
      <span
        className="propiq-scorebar-fill"
        style={{ width: `${Math.max(0, Math.min(100, score))}%`, background: scoreRampFill(score) }}
      />
    )}
  </span>
);

/**
 * The scale key. A single series needs no legend, but a reader still has to be
 * told the hue runs low-to-high rather than coding four categories.
 */
export const ScoreRampKey = ({ className }: { className?: string }) => (
  <p className={cn('flex items-center gap-2 text-[10px] text-[var(--text-muted)]', className)}>
    <span data-figure>0</span>
    <span className="propiq-ramp-key" aria-hidden>
      {Array.from({ length: SCORE_RAMP_STEPS }, (_, i) => (
        <span key={i} style={{ background: `var(--seq-score-${i + 1})` }} />
      ))}
    </span>
    <span data-figure>100</span>
    <span>pillar score. Darker is higher; it is not a verdict.</span>
  </p>
);
