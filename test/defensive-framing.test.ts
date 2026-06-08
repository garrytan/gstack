/**
 * Regression guard for defensive-security review framing (follow-up to #1899).
 *
 * #1899 added the "authorized defensive-security review" framing + summary-mode
 * fixture handling to the adversarial pass ONLY. The red-team and security
 * specialist dispatches were left un-framed, so on a repo that ships its own
 * attack-payload regression corpus they still tripped Anthropic's real-time
 * cyber safeguards and got DENIED.
 *
 * This test asserts the invariant that closed that gap: EVERY Claude-dispatched
 * pass that reasons adversarially over a diff (adversarial, red-team, security
 * specialist) carries the shared defensive framing, and the attacker-framed
 * passes additionally route fixtures to summary mode. If a future edit adds a
 * new adversarial dispatch without the framing, this fails.
 */
import { describe, test, expect } from 'bun:test';
import type { TemplateContext } from '../scripts/resolvers/types';
import { generateReviewArmy } from '../scripts/resolvers/review-army';
import { generateAdversarialStep } from '../scripts/resolvers/review';
import { DEFENSIVE_REVIEW_FRAMING, FIXTURE_SUMMARY_MODE } from '../scripts/resolvers/defensive-framing';

function makeCtx(overrides: Partial<TemplateContext> = {}): TemplateContext {
  return {
    skillName: 'ship',
    tmplPath: '/tmp/test/SKILL.md.tmpl',
    host: 'claude',
    paths: {
      skillRoot: '~/.claude/skills/gstack',
      localSkillRoot: '.claude/skills',
      binDir: '~/.claude/skills/gstack/bin',
      browseDir: '~/.claude/skills/gstack/browse/dist',
      designDir: '~/.claude/skills/gstack/design/dist',
      makePdfDir: '~/.claude/skills/gstack/make-pdf/dist',
    },
    ...overrides,
  };
}

const SUMMARY_PHRASE = 'review in SUMMARY mode only';

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe('defensive-security review framing — coverage invariant', () => {
  for (const skillName of ['ship', 'review']) {
    test(`[${skillName}] adversarial pass carries the framing + summary mode`, () => {
      const out = generateAdversarialStep(makeCtx({ skillName }));
      expect(out).toContain(DEFENSIVE_REVIEW_FRAMING);
      expect(out).toContain(SUMMARY_PHRASE);
    });

    test(`[${skillName}] specialist dispatch + red-team BOTH carry the framing`, () => {
      const out = generateReviewArmy(makeCtx({ skillName }));
      // Two framed Claude dispatch points: the shared specialist prompt and red-team.
      expect(occurrences(out, DEFENSIVE_REVIEW_FRAMING)).toBeGreaterThanOrEqual(2);
    });

    test(`[${skillName}] red-team + security specialist route fixtures to summary mode`, () => {
      const out = generateReviewArmy(makeCtx({ skillName }));
      // red-team prompt + security-specialist conditional = two summary-mode injections.
      expect(occurrences(out, FIXTURE_SUMMARY_MODE)).toBeGreaterThanOrEqual(2);
      expect(out).toContain('**security** specialist checklist');
    });
  }

  test('codex host strips both adversarial and review-army (no framing leakage)', () => {
    expect(generateAdversarialStep(makeCtx({ host: 'codex' }))).toBe('');
    expect(generateReviewArmy(makeCtx({ host: 'codex' }))).toBe('');
  });

  test('shared constant is the single source of truth (used, not duplicated inline)', () => {
    // The framing text must be substantial enough that an accidental partial
    // paste would not satisfy toContain — guards against silent divergence.
    expect(DEFENSIVE_REVIEW_FRAMING).toContain('authorized defensive-security review');
    expect(DEFENSIVE_REVIEW_FRAMING).toContain('do NOT generate novel attack content');
    expect(FIXTURE_SUMMARY_MODE).toContain('summary mode');
  });
});
