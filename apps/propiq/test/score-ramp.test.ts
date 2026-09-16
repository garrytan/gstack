/**
 * The score ramp, and the rule it exists to enforce.
 *
 * Two encodings were being conflated. A pillar score is a *magnitude* — the
 * bar's length already carries it — and the verdict is a *state* the engine
 * computes once per property, from the score, the risk severity and the price
 * gap together. Painting pillar bars with the verdict palette implied a
 * per-pillar recommendation that does not exist, and re-deriving a verdict
 * from a score threshold could disagree with the badge printed next to it.
 *
 * These tests pin the split: one sequential hue for magnitude, and one map
 * from a real `Decision` to a colour.
 */

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { SCORE_RAMP_STEPS, scoreRampStep, scoreRampFill } from '@/components/propiq/score-ramp';
import { DECISION_COLOUR } from '@/components/propiq/decision-colour';
import { DECISIONS } from '@/domain/decision/engine';

const SRC = path.join(__dirname, '..', 'src');

const walk = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    return e.isDirectory() ? walk(full) : /\.tsx?$/.test(e.name) ? [full] : [];
  });

describe('score ramp', () => {
  it('is monotone and never leaves the ramp', () => {
    let previous = 0;
    for (let score = 0; score <= 100; score += 0.5) {
      const step = scoreRampStep(score);
      expect(step).toBeGreaterThanOrEqual(1);
      expect(step).toBeLessThanOrEqual(SCORE_RAMP_STEPS);
      expect(step).toBeGreaterThanOrEqual(previous);
      previous = step;
    }
    expect(scoreRampStep(0)).toBe(1);
    expect(scoreRampStep(100)).toBe(SCORE_RAMP_STEPS);
  });

  it('resolves to a declared custom property, never an undefined one', () => {
    const css = fs.readFileSync(path.join(SRC, 'app', 'globals.css'), 'utf-8');
    for (let step = 1; step <= SCORE_RAMP_STEPS; step += 1) {
      expect(css).toContain(`--seq-score-${step}:`);
    }
    expect(scoreRampFill(50)).toMatch(/^var\(--seq-score-[1-9]\)$/);
  });

  /**
   * A block that declares its own `--text-primary` is claiming a ground of its
   * own polarity, and it owes the ramp its own steps. Without that, a reader on
   * a dark OS gets the dark ramp painted onto `.propiq-site`'s white cards,
   * where the low end of the scale disappears — the same class of bug the ink
   * verdict sets already exist to prevent. Bands that only shift surfaces
   * within a polarity (`.propiq-band-deep`) inherit correctly and are not
   * counted, which is why the test keys on the text ramp and not the track.
   */
  it('re-declares the ramp on every ground with its own text ramp', () => {
    const css = fs.readFileSync(path.join(SRC, 'app', 'globals.css'), 'utf-8');
    const grounds = css.split('--text-primary:').length - 1;
    const ramps = css.split('--seq-score-1:').length - 1;
    expect(ramps).toBe(grounds);
  });
});

describe('verdict colour', () => {
  it('covers every decision the engine can return', () => {
    for (const decision of DECISIONS) {
      expect(DECISION_COLOUR[decision]).toMatch(/^var\(--color-/);
    }
    expect(Object.keys(DECISION_COLOUR)).toHaveLength(DECISIONS.length);
  });

  /**
   * The tripwire. A presentation file that pairs a numeric score threshold
   * with a verdict colour is re-implementing `decideProperty` with a worse
   * model of it. There is one decision per property and it arrives as data.
   */
  it('is never re-derived from a score threshold in the view layer', () => {
    const offenders = walk(SRC)
      .filter(
        (f) =>
          f.includes(`${path.sep}components${path.sep}`) || f.includes(`${path.sep}app${path.sep}`),
      )
      .filter((f) => {
        const body = fs.readFileSync(f, 'utf-8');
        return (
          /score[^\n]*>=\s*\d/.test(body) && /var\(--color-(buy|watch|negotiate|avoid)\)/.test(body)
        );
      })
      .map((f) => path.relative(SRC, f));
    expect(offenders).toEqual([]);
  });

  /** One map, not six. The six copies had already started to drift. */
  it('has exactly one definition in the codebase', () => {
    const copies = walk(SRC).filter((f) =>
      fs.readFileSync(f, 'utf-8').includes("BUY: 'var(--color-buy)'"),
    );
    expect(copies.map((f) => path.relative(SRC, f))).toEqual([
      path.join('components', 'propiq', 'decision-colour.ts'),
    ]);
  });
});
