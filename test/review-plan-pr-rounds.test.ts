/**
 * GST-2673: the review plan caps full review rounds per pull request (R51) with the full rounds earlier /ship runs on the
 * PR already spent (--prior-full from PR_REVIEW_FLAGS), prints every earlier round as pr_rounds= (--prior-rounds), and
 * a recorded round grant buys one more full round at its head.
 */
import { describe, expect, test } from 'bun:test';
import { FULL_PASS_CAP, nextStep, type History } from '../lib/review-depth';

const h = (x: Partial<History>): History => ({ fullPasses: 0, last: 'none', ...x });

describe('PR round cap', () => {
  test('no prior rounds leaves the plan as today', () => {
    expect(nextStep(h({})).step).toBe('full');
    expect(nextStep(h({ lean: true })).step).toBe('full');
    expect(nextStep(h({ priorRounds: 0, priorFull: 0, fullPasses: 1, last: 'full', fixedBlocking: true }), 'standard').reason).not.toContain('PR_ROUND_CAP');
  });

  // Value: protects=the plan's d3a case: a run of a full pass plus a scoped pass 2 leaves the next head one full round;
  //   fails_when=the cap counts scoped passes or fix-checks as full rounds; seam=nextStep; no_claim=preflight's re-check route
  test('one prior full round (two rounds with a scoped pass 2): pass 1 is the PR\'s second and last full round, in both tables', () => {
    for (const lean of [false, true]) {
      const n = nextStep(h({ priorRounds: 2, priorFull: 1, lean }));
      expect(n.step).toBe('full');
      expect(n.reason).toContain('full round 2 of 2, the last');
    }
  });

  test('one prior full round: after pass 1, a below-floor fix keeps its in-run fix-check and a fixed blocker stops for the lane, not the owner', () => {
    expect(nextStep(h({ priorFull: 1, fullPasses: 1, last: 'full', fixedBelow: true }), 'standard').step).toBe('fix-check');
    const stop = nextStep(h({ priorFull: 1, fullPasses: 1, last: 'full', fixedBlocking: true }), 'standard');
    expect(stop.step).toBe('stop');
    expect(stop.reason).toStartWith('PR_ROUND_CAP');
    expect(stop.reason).not.toContain('for the owner');
  });

  test('a fix-check stays the in-run table\'s call: lean\'s one fix-check after a fixed blocker still runs', () => {
    expect(nextStep(h({ priorFull: 1, fullPasses: 1, last: 'full', fixedBlocking: true, lean: true }), 'standard').step).toBe('fix-check');
  });

  // Value: protects=the plan's d3a case: two runs of a full pass plus a fix-check stop the next head at pr_rounds=4;
  //   fails_when=a third /ship run gets another full round without a grant; seam=nextStep; no_claim=the CLI's pr_rounds= print (pr-round-cli)
  test('two prior full rounds stop pass 1 with PR_ROUND_CAP', () => {
    const n = nextStep(h({ priorRounds: 4, priorFull: FULL_PASS_CAP }));
    expect(n.step).toBe('stop');
    expect(n.reason).toStartWith('PR_ROUND_CAP: this PR already had 2 full review rounds');
  });

  test('a round grant buys one more full round at its head, never two', () => {
    expect(nextStep(h({ priorFull: 2, roundGrant: 'a-1' })).step).toBe('full');
    expect(nextStep(h({ priorFull: 2, roundGrant: 'a-1', fullPasses: 1, last: 'full', fixedBlocking: true }), 'standard').reason).toStartWith('PR_ROUND_CAP');
  });

  test('gate class still runs Step 11\'s voices before the PR cap stop', () => {
    expect(nextStep(h({ priorFull: 2, gate: true, adversarialRan: false })).step).toBe('voices');
  });

  test('a blocking finding still open keeps today\'s stop', () => {
    const n = nextStep(h({ priorFull: 1, fullPasses: 1, last: 'full', blockingOpen: true }), 'standard');
    expect(n.step).toBe('stop');
  });
});
