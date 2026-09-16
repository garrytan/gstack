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
   * own polarity, and it owes the ramp and the card surface its own values.
   * Without that, a reader on a dark OS gets the dark ramp painted onto white
   * cards, and `.propiq-card` paints a colour from the wrong world — the same
   * class of bug the ink verdict sets already exist to prevent.
   *
   * The check parses blocks rather than counting declarations: a band that
   * shifts surfaces within one polarity may declare a card surface without
   * owing a text ramp, and counting cannot tell that apart from a ground that
   * forgot one.
   */
  it('gives every ground its own ramp and card surface', () => {
    const css = fs.readFileSync(path.join(SRC, 'app', 'globals.css'), 'utf-8');
    const grounds = [...css.matchAll(/\{([^{}]*)\}/g)]
      .map((m) => m[1] ?? '')
      .filter((body) => body.includes('--text-primary:'));

    // A floor, so deleting every ground cannot make the loop below pass
    // vacuously. The exact count moves whenever a subtree is added or retired.
    expect(grounds.length).toBeGreaterThanOrEqual(5);
    for (const body of grounds) {
      expect(body).toContain('--seq-score-1:');
      expect(body).toContain('--surface-card:');
    }
    // And the component never reaches past the token for a literal.
    expect(css).not.toMatch(/\.propiq-card \{[^}]*background:\s*#/);
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
