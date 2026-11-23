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

  // Value: protects=GST-3562 A at the PR cap: a fix made in the PR's last full round gets one read-only full review of the final
  //   head with no fix round, in both tables, and a fix after that review stops for the lane's Captain, never the owner;
  //   fails_when=the cap plans a fix-check, ships the fix unread, or stops before the read-only review; seam=nextStep;
  //   no_claim=the CLI's pr_rounds= print (pr-round-cli)
  test('one prior full round: after pass 1, any fix gets one read-only full review, and a fix after it stops for the lane\'s Captain, not the owner', () => {
    for (const lean of [false, true]) for (const fix of [{ fixedBelow: true }, { fixedBlocking: true }, { touchedGate: true }]) {
      const n = nextStep(h({ priorFull: 1, fullPasses: 1, last: 'full', lean, ...fix }), 'standard');
      expect([lean, fix, n.step]).toEqual([lean, fix, 'full']);
      expect(n.reason).toStartWith('read-only final review (R51): fixes changed code after the last round');
      expect(n.reason).toContain('(GST-3562 A); this PR already had 1 full review round on earlier heads');
      const stop = nextStep(h({ priorFull: 1, fullPasses: 2, last: 'full', lean, ...fix }), 'standard');
      expect([lean, fix, stop.step]).toEqual([lean, fix, 'stop']);
      expect(stop.reason).toStartWith("a fix followed the read-only final review: the lane's Captain decides (R51)");
      expect(stop.reason).not.toContain('for the owner');
    }
  });

  // Value: protects=F1's past-cap case: a PR with two full rounds whose own code changed gets one read-only full review of
  //   the merge head; fails_when=a third /ship run gets a fix round without a grant, or the merge head goes unreviewed;
  //   seam=nextStep; no_claim=the CLI's pr_rounds= print (pr-round-cli)
  test('two prior full rounds: pass 1 is one read-only full review with no fix round, in both tables', () => {
    for (const lean of [false, true]) {
      const n = nextStep(h({ priorRounds: 4, priorFull: FULL_PASS_CAP, lean }));
      expect(n.step).toBe('full');
      expect(n.reason).toStartWith('read-only final review (R51): this PR already had 2 full review rounds');
    }
  });

  test('after the read-only review: unfixed below-floor findings ship as notes, and a fix of any kind or a blocker stops for the lane\'s Captain (GST-3562 A)', () => {
    for (const lean of [false, true]) {
      expect(nextStep(h({ priorFull: 2, fullPasses: 1, last: 'full', lean })).step).toBe('done');
      expect(nextStep(h({ priorFull: 2, fullPasses: 1, last: 'full', fixedBelow: true, lean }), 'standard')).toMatchObject({ step: 'stop', reason: expect.stringContaining("a fix followed the read-only final review: the lane's Captain decides") });
      for (const x of [{ blockingOpen: true }, { fixedBlocking: true }, { touchedGate: true, fixedBelow: true }]) {
        const stop = nextStep(h({ priorFull: 3, fullPasses: 1, last: 'full', lean, ...x }), 'standard');
        expect(stop.step).toBe('stop');
        expect(stop.reason).toStartWith('PR_ROUND_CAP: the read-only final review');
        expect(stop.reason).toContain("lane's Captain");
      }
    }
  });

  // Value: protects=the read-only stop offers only what the Captain can do: GST-3562 A plans no new fix-check, so the stop offers
  //   ship-with-the-note, park, or a new /ship run's read-only full review of the kept fix, and never a fix-check grant or a round
  //   grant; fails_when=the stop offers a grant that buys a fix round; seam=nextStep; no_claim=history's grant route
  // GST-2968 had the stop name the fix-check grant that answers its stop record; a grant recorded before GST-3562 still buys it for
  //   one release (test/round-cap-granted-stop.test.ts), but the stop no longer offers one.
  test('the read-only stop offers ship-with-the-note, park, or keeping the fix for one more read-only full review, never a fix-check grant', () => {
    for (const roundGrant of [undefined, 'a-000000000001']) {
      const stop = nextStep(h({ priorFull: 3, fullPasses: 1, last: 'full', fixedBlocking: true, roundGrant }), 'standard');
      expect(stop.step).toBe('stop');
      expect(stop.reason).toContain("the lane's Captain decides (ship with the note, park, or keep the fix and run /ship again for one more read-only full review of the final head)");
      expect(stop.reason).not.toContain('fix-check grant');
      expect(stop.reason).not.toContain('does not buy a fix round');
    }
  });

  // GST-2968 (matrix row G3): the granted round keeps its fix round (gstack#4272: the grant raised the cap by one, so a blocker the
  //   granted pass fixed stopped again at PR_ROUND_CAP), and nothing past it.
  test('a round grant buys one more full round at its head with its fix round, never two', () => {
    expect(nextStep(h({ priorFull: 2, roundGrant: 'a-1' })).step).toBe('full');
    expect(nextStep(h({ priorFull: 3, roundGrant: 'a-1' }))).toMatchObject({ step: 'full', reason: expect.stringContaining('read-only final review') });
    for (const depth of ['standard', 'full'] as const) {
      const fix = nextStep(h({ priorFull: 2, roundGrant: 'a-1', fullPasses: 1, last: 'full', fixedBlocking: true }), depth);
      expect(['full', 'scoped']).toContain(fix.step);
      expect(fix.reason).toContain("round grant a-1 bought pass 1 as this PR's full round 3, and this is that round's fix round");
    }
    expect(nextStep(h({ priorFull: 2, roundGrant: 'a-1', fullPasses: 2, last: 'full', fixedBlocking: true }), 'standard').step).toBe('stop');
    expect(nextStep(h({ priorFull: 2, fullPasses: 1, last: 'full', fixedBlocking: true }), 'standard').reason).toStartWith('PR_ROUND_CAP');
  });

  test('gate class still runs Step 11\'s voices before the PR cap stop', () => {
    expect(nextStep(h({ priorFull: 2, fullPasses: 1, last: 'full', blockingOpen: true, gate: true, adversarialRan: false }), 'standard').step).toBe('voices');
  });

  test('a blocking finding still open keeps today\'s stop', () => {
    const n = nextStep(h({ priorFull: 1, fullPasses: 1, last: 'full', blockingOpen: true }), 'standard');
    expect(n.step).toBe('stop');
  });
});
