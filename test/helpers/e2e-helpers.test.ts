/**
 * Free, deterministic unit tests for the pure/local helpers added alongside
 * the schema-consolidation-bias E2E evals. matchesUnnegated() and
 * setupPlanEngReviewFixture() were previously only exercised indirectly by
 * the paid, EVALS=1-gated E2E tests in skill-e2e-plan.test.ts — a bug in
 * either could silently flip an eval's pass/fail verdict and be
 * indistinguishable from ordinary LLM wording variance. These tests run in
 * the free `bun test` suite instead.
 */

import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import { matchesUnnegated, setupPlanEngReviewFixture, ROOT } from './e2e-helpers';
import * as path from 'path';

describe('matchesUnnegated', () => {
  const splitPattern = /(promote|split|convert|extract|move|normali[sz]e)[^.]{0,80}payload[^.]{0,80}(column|field)/i;

  test('finds an unnegated positive match', () => {
    expect(matchesUnnegated(
      'I recommend you promote the payload into explicit columns for the common fields.',
      splitPattern,
    )).toBe(true);
  });

  test('ignores a match preceded by "not"', () => {
    expect(matchesUnnegated(
      'I would not extract the payload into columns, since the schema is Stripe-controlled.',
      splitPattern,
    )).toBe(false);
  });

  test('ignores a match preceded by "n\'t" (doesn\'t / wouldn\'t / shouldn\'t)', () => {
    expect(matchesUnnegated(
      'This wouldn\'t promote the payload into columns.',
      splitPattern,
    )).toBe(false);
  });

  test('ignores a match preceded by "without"', () => {
    expect(matchesUnnegated(
      'The payload stays as-is without splitting the payload into columns.',
      splitPattern,
    )).toBe(false);
  });

  test('ignores a match that is the rejected half of a "rather than" contrast', () => {
    // "Keep it on the existing model RATHER THAN promote the payload into
    // columns" — the rejected alternative matches the pattern just as
    // strongly as a real recommendation would, with no single negation
    // word (not/never/without/...) anywhere near it.
    expect(matchesUnnegated(
      'Keep this field on the existing model rather than promote the payload into explicit columns.',
      splitPattern,
    )).toBe(false);
  });

  test('ignores a match that is the rejected half of an "instead of" contrast', () => {
    expect(matchesUnnegated(
      'Keep this on the existing model instead of splitting the payload into columns.',
      splitPattern,
    )).toBe(false);
  });

  test('catches a positive match even when an unrelated negation appears earlier in the text', () => {
    expect(matchesUnnegated(
      'This is not a JSONField concern. Separately, I recommend you promote the payload into explicit columns.',
      splitPattern,
    )).toBe(true);
  });

  test('finds a positive match after a negated one in an earlier sentence (does not short-circuit on the first match)', () => {
    // First sentence is negated ("not extract..."), second is a genuine
    // recommendation ("should promote..."). The period between them bounds
    // the pattern's [^.]{0,80} window to one sentence each, so this must
    // find two distinct matches — matchesUnnegated must not stop scanning
    // after the first (negated) hit.
    expect(matchesUnnegated(
      'I would not extract the payload into columns for the rare fields. For the common fields, I would promote the payload into explicit columns.',
      splitPattern,
    )).toBe(true);
  });

  test('returns false when the pattern never matches at all', () => {
    expect(matchesUnnegated('This review has nothing to do with payloads or columns.', splitPattern)).toBe(false);
  });

  test('ignores a negation far earlier in the same (period-free) sentence', () => {
    // The negation-lookback scans to the sentence boundary, not a fixed
    // character count — this is the scenario that motivated that design.
    // "not" sits well over 20 characters before "extract...payload...columns"
    // but is still part of the same sentence (no period between them).
    expect(matchesUnnegated(
      "I do not think it's worth the added complexity of maintaining a separate table just to extract the payload into columns for these rare cases.",
      splitPattern,
    )).toBe(false);
  });

  test('does not infinite-loop on a zero-width-adjacent pattern', () => {
    // Guards the re.lastIndex++ zero-width-match protection. Note: a bare
    // quantifier pattern like /x*/ always produces an empty match at index 0
    // with nothing preceding it (so it's trivially "unnegated" and returns
    // true immediately) — this test's value is that it terminates at all,
    // not that it exercises the negated branch of the loop.
    const zeroWidthish = /x*/i;
    expect(() => matchesUnnegated('no x here', zeroWidthish)).not.toThrow();
  });

  test('accepts a pattern that already has the global flag', () => {
    const globalPattern = /payload/gi;
    expect(matchesUnnegated('the payload arrived', globalPattern)).toBe(true);
  });
});

describe('setupPlanEngReviewFixture', () => {
  test('creates a git repo with plan.md, SKILL.md, and sections/ copied from the real skill', () => {
    const planDir = setupPlanEngReviewFixture('e2e-helpers-test-fixture-', '# Plan: test fixture\n\nSome content.\n');
    try {
      expect(fs.existsSync(path.join(planDir, '.git'))).toBe(true);
      expect(fs.readFileSync(path.join(planDir, 'plan.md'), 'utf-8')).toContain('Plan: test fixture');
      expect(fs.existsSync(path.join(planDir, 'plan-eng-review', 'SKILL.md'))).toBe(true);

      const realSkillMd = fs.readFileSync(path.join(ROOT, 'plan-eng-review', 'SKILL.md'), 'utf-8');
      const copiedSkillMd = fs.readFileSync(path.join(planDir, 'plan-eng-review', 'SKILL.md'), 'utf-8');
      expect(copiedSkillMd).toBe(realSkillMd);

      const realSectionsDir = path.join(ROOT, 'plan-eng-review', 'sections');
      if (fs.existsSync(realSectionsDir)) {
        expect(fs.existsSync(path.join(planDir, 'plan-eng-review', 'sections', 'review-sections.md'))).toBe(true);
      }
    } finally {
      fs.rmSync(planDir, { recursive: true, force: true });
    }
  });
});
