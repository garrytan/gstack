/**
 * Tests for Supabase edge function pure helpers:
 *   - regression-alert: computePassRate, shouldAlert, formatSlackMessage
 *   - weekly-digest: formatDigestMessage
 *
 * These edge functions use Deno.serve() at module level and import from
 * https://esm.sh, so we mock Deno + the supabase module before importing.
 */

import { describe, test, expect, mock, beforeAll } from 'bun:test';

// Mock Deno global so edge function modules can be imported in Bun
(globalThis as any).Deno = {
  serve: () => {},
  env: { get: () => '' },
};

// Mock the ESM supabase import used by edge functions
mock.module('https://esm.sh/@supabase/supabase-js@2', () => ({
  createClient: () => ({}),
}));

// Dynamic imports so the mocks are in place before module resolution
let computePassRate: (passed: number, total: number) => number | null;
let shouldAlert: (currentRate: number | null, baselineRate: number | null, thresholdPct?: number) => boolean;
let formatSlackMessage: (opts: { repoSlug: string; branch: string; previousRate: number; currentRate: number }) => string;
let formatDigestMessage: (data: any) => string;

beforeAll(async () => {
  const regressionAlert = await import('../supabase/functions/regression-alert/index');
  computePassRate = regressionAlert.computePassRate;
  shouldAlert = regressionAlert.shouldAlert;
  formatSlackMessage = regressionAlert.formatSlackMessage;

  const weeklyDigest = await import('../supabase/functions/weekly-digest/index');
  formatDigestMessage = weeklyDigest.formatDigestMessage;
});

// ---------- regression-alert ----------

describe('edge-functions / regression-alert', () => {
  describe('computePassRate', () => {
    test('normal case: (8, 10) → 80', () => {
      expect(computePassRate(8, 10)).toBe(80);
    });

    test('perfect score: (10, 10) → 100', () => {
      expect(computePassRate(10, 10)).toBe(100);
    });

    test('zero passed: (0, 10) → 0', () => {
      expect(computePassRate(0, 10)).toBe(0);
    });

    test('total_tests=0: (0, 0) → null', () => {
      expect(computePassRate(0, 0)).toBeNull();
    });

    test('single test passed: (1, 1) → 100', () => {
      expect(computePassRate(1, 1)).toBe(100);
    });
  });

  describe('shouldAlert', () => {
    test('regression over default threshold: (75, 85) → true', () => {
      // Drop of 10% > default 5% threshold
      expect(shouldAlert(75, 85)).toBe(true);
    });

    test('regression under default threshold: (82, 85) → false', () => {
      // Drop of 3% < default 5% threshold
      expect(shouldAlert(82, 85)).toBe(false);
    });

    test('improvement: (90, 85) → false', () => {
      expect(shouldAlert(90, 85)).toBe(false);
    });

    test('custom threshold: (80, 85, 3) → true', () => {
      // Drop of 5% > custom 3% threshold
      expect(shouldAlert(80, 85, 3)).toBe(true);
    });

    test('null currentRate: (null, 85) → false', () => {
      expect(shouldAlert(null, 85)).toBe(false);
    });

    test('null baselineRate: (75, null) → false', () => {
      expect(shouldAlert(75, null)).toBe(false);
    });

    test('both null: (null, null) → false', () => {
      expect(shouldAlert(null, null)).toBe(false);
    });

    test('exact threshold: (80, 85, 5) → false (not strictly greater)', () => {
      // Drop is exactly 5%, threshold is 5%, check uses > not >=
      expect(shouldAlert(80, 85, 5)).toBe(false);
    });
  });

  describe('formatSlackMessage', () => {
    test('regression: shows :warning: and "regressed" with correct rates', () => {
      const msg = formatSlackMessage({
        repoSlug: 'my-repo',
        branch: 'feature-x',
        previousRate: 90,
        currentRate: 75,
      });
      expect(msg).toContain(':warning:');
      expect(msg).toContain('regressed');
      expect(msg).toContain('90%');
      expect(msg).toContain('75%');
    });

    test('improvement: shows "improved"', () => {
      const msg = formatSlackMessage({
        repoSlug: 'my-repo',
        branch: 'fix-branch',
        previousRate: 80,
        currentRate: 95,
      });
      expect(msg).toContain('improved');
      expect(msg).not.toContain('regressed');
    });

    test('includes branch and repo slug', () => {
      const msg = formatSlackMessage({
        repoSlug: 'acme/widget',
        branch: 'main',
        previousRate: 85,
        currentRate: 80,
      });
      expect(msg).toContain('acme/widget');
      expect(msg).toContain('main');
    });

    test('delta format: negative shows no plus sign', () => {
      const msg = formatSlackMessage({
        repoSlug: 'r',
        branch: 'b',
        previousRate: 90,
        currentRate: 80,
      });
      // delta = 80 - 90 = -10, should show "-10%" with no plus
      expect(msg).toContain('-10%');
      expect(msg).not.toContain('+-10%');
    });

    test('delta format: positive shows + sign', () => {
      const msg = formatSlackMessage({
        repoSlug: 'r',
        branch: 'b',
        previousRate: 80,
        currentRate: 90,
      });
      // delta = 90 - 80 = +10, should show "+10%"
      expect(msg).toContain('+10%');
    });
  });
});

// ---------- weekly-digest ----------

describe('edge-functions / weekly-digest', () => {
  describe('formatDigestMessage', () => {
    test('full data: shows all sections', () => {
      const msg = formatDigestMessage({
        teamSlug: 'alpha-team',
        evalRuns: 12,
        evalPassRate: 87,
        evalPassRateDelta: 3,
        shipsByPerson: [
          { email: 'alice@co.com', count: 5 },
          { email: 'bob@co.com', count: 3 },
        ],
        totalShips: 8,
        sessionCount: 42,
        topTools: [
          { tool: 'Read', count: 100 },
          { tool: 'Edit', count: 50 },
        ],
        totalCost: 12.34,
      });

      // Header
      expect(msg).toContain(':bar_chart:');
      expect(msg).toContain('alpha-team');

      // Evals section
      expect(msg).toContain('12 runs');
      expect(msg).toContain('87% pass rate');
      expect(msg).toContain('+3% from last week');

      // Ships section
      expect(msg).toContain(':rocket:');
      expect(msg).toContain('8 PRs');
      expect(msg).toContain('alice: 5');
      expect(msg).toContain('bob: 3');

      // Sessions section
      expect(msg).toContain(':robot_face:');
      expect(msg).toContain('42');
      expect(msg).toContain('Read(100)');
      expect(msg).toContain('Edit(50)');

      // Cost section
      expect(msg).toContain(':moneybag:');
      expect(msg).toContain('$12.34');
    });

    test('evals only: shows eval line, no ships/sessions/cost', () => {
      const msg = formatDigestMessage({
        teamSlug: 'solo',
        evalRuns: 5,
        evalPassRate: 100,
        evalPassRateDelta: null,
        shipsByPerson: [],
        totalShips: 0,
        sessionCount: 0,
        topTools: [],
        totalCost: 0,
      });

      expect(msg).toContain('5 runs');
      expect(msg).toContain('100% pass rate');
      // No delta since evalPassRateDelta is null
      expect(msg).not.toContain('from last week');
      // No ships, sessions, or cost
      expect(msg).not.toContain(':rocket:');
      expect(msg).not.toContain(':robot_face:');
      expect(msg).not.toContain(':moneybag:');
    });

    test('quiet week: all zeros → "Quiet week" message', () => {
      const msg = formatDigestMessage({
        teamSlug: 'idle-team',
        evalRuns: 0,
        evalPassRate: null,
        evalPassRateDelta: null,
        shipsByPerson: [],
        totalShips: 0,
        sessionCount: 0,
        topTools: [],
        totalCost: 0,
      });

      expect(msg).toContain('Quiet week');
      expect(msg).not.toContain(':white_check_mark:');
      expect(msg).not.toContain(':rocket:');
      expect(msg).not.toContain(':robot_face:');
      expect(msg).not.toContain(':moneybag:');
    });

    test('ships with multiple people: sorted by count desc, truncated to 5', () => {
      const msg = formatDigestMessage({
        teamSlug: 'big-team',
        evalRuns: 0,
        evalPassRate: null,
        evalPassRateDelta: null,
        shipsByPerson: [
          { email: 'person1@co.com', count: 1 },
          { email: 'person2@co.com', count: 7 },
          { email: 'person3@co.com', count: 3 },
          { email: 'person4@co.com', count: 5 },
          { email: 'person5@co.com', count: 2 },
          { email: 'person6@co.com', count: 10 },
          { email: 'person7@co.com', count: 4 },
        ],
        totalShips: 32,
        sessionCount: 0,
        topTools: [],
        totalCost: 0,
      });

      // person6 (10), person2 (7), person4 (5), person7 (4), person3 (3)
      // person5 (2) and person1 (1) should be truncated
      expect(msg).toContain('person6: 10');
      expect(msg).toContain('person2: 7');
      expect(msg).toContain('person4: 5');
      expect(msg).toContain('person7: 4');
      expect(msg).toContain('person3: 3');
      expect(msg).not.toContain('person5: 2');
      expect(msg).not.toContain('person1: 1');
    });

    test('pass rate delta: positive shows +, negative shows -', () => {
      const posMsg = formatDigestMessage({
        teamSlug: 't',
        evalRuns: 1,
        evalPassRate: 90,
        evalPassRateDelta: 5,
        shipsByPerson: [],
        totalShips: 0,
        sessionCount: 0,
        topTools: [],
        totalCost: 0,
      });
      expect(posMsg).toContain('+5% from last week');

      const negMsg = formatDigestMessage({
        teamSlug: 't',
        evalRuns: 1,
        evalPassRate: 80,
        evalPassRateDelta: -8,
        shipsByPerson: [],
        totalShips: 0,
        sessionCount: 0,
        topTools: [],
        totalCost: 0,
      });
      expect(negMsg).toContain('-8% from last week');
      expect(negMsg).not.toContain('+-8%');
    });

    test('no pass rate data: omits the rate portion', () => {
      const msg = formatDigestMessage({
        teamSlug: 't',
        evalRuns: 3,
        evalPassRate: null,
        evalPassRateDelta: null,
        shipsByPerson: [],
        totalShips: 0,
        sessionCount: 0,
        topTools: [],
        totalCost: 0,
      });

      expect(msg).toContain('3 runs');
      expect(msg).not.toContain('pass rate');
      expect(msg).not.toContain('from last week');
    });
  });
});
