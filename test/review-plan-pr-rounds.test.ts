/**
 * GST-2673: the review plan caps rounds per pull request (R51) with the rounds earlier /ship runs on the PR already
 * spent (--prior-rounds from PR_REVIEW_HISTORY), and a recorded round grant buys one more at its head.
 */
import { describe, expect, test } from 'bun:test';
import { FULL_PASS_CAP, nextStep, type History } from '../lib/review-depth';

const h = (x: Partial<History>): History => ({ fullPasses: 0, last: 'none', ...x });

describe('PR round cap', () => {
  test('no prior rounds leaves the plan as today', () => {
    expect(nextStep(h({})).step).toBe('full');
    expect(nextStep(h({ lean: true })).step).toBe('full');
  });

  test('one prior round: pass 1 is the PR\'s second and last round, in both tables', () => {
    for (const lean of [false, true]) {
      const n = nextStep(h({ priorRounds: 1, lean }));
      expect(n.step).toBe('full');
      expect(n.reason).toContain('round 2 of 2');
    }
  });

  test('one prior round: after pass 1, a below-floor fix ships as notes and a fixed blocker stops for the lane, not the owner', () => {
    const done = nextStep(h({ priorRounds: 1, fullPasses: 1, last: 'full', fixedBelow: true }), 'standard');
    expect(done.step).toBe('done');
    const stop = nextStep(h({ priorRounds: 1, fullPasses: 1, last: 'full', fixedBlocking: true }), 'standard');
    expect(stop.step).toBe('stop');
    expect(stop.reason).toStartWith('PR_ROUND_CAP');
    expect(stop.reason).not.toContain('for the owner');
    const lean = nextStep(h({ priorRounds: 1, fullPasses: 1, last: 'full', fixedBlocking: true, lean: true }), 'standard');
    expect(lean.step).toBe('stop');
    expect(lean.reason).toStartWith('PR_ROUND_CAP');
  });

  test('two prior rounds stop pass 1 with PR_ROUND_CAP', () => {
    const n = nextStep(h({ priorRounds: FULL_PASS_CAP }));
    expect(n.step).toBe('stop');
    expect(n.reason).toStartWith('PR_ROUND_CAP');
  });

  test('a round grant buys one more round at its head, never two', () => {
    expect(nextStep(h({ priorRounds: 2, roundGrant: 'a-1' })).step).toBe('full');
    expect(nextStep(h({ priorRounds: 2, roundGrant: 'a-1', fullPasses: 1, last: 'full', fixedBlocking: true }), 'standard').reason).toStartWith('PR_ROUND_CAP');
  });

  test('gate class still runs Step 11\'s voices before the PR cap stop', () => {
    expect(nextStep(h({ priorRounds: 2, gate: true, adversarialRan: false })).step).toBe('voices');
  });

  test('a blocking finding still open keeps today\'s stop', () => {
    const n = nextStep(h({ priorRounds: 1, fullPasses: 1, last: 'full', blockingOpen: true }), 'standard');
    expect(n.step).toBe('stop');
  });
});
