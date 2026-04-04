/**
 * Tests for dashboard query/transform functions (pure, no network).
 */

import { describe, test, expect } from 'bun:test';
import {
  detectRegressions,
  computeVelocity,
  computeCostTrend,
  computeLeaderboard,
  computeQATrend,
  computeEvalTrend,
} from '../lib/dashboard-queries';

// --- Helpers ---

const now = new Date().toISOString();
const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();
const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

function makeEvalRun(overrides: Record<string, unknown> = {}) {
  return {
    timestamp: now,
    user_id: 'u1',
    email: 'alice@test.com',
    branch: 'main',
    passed: 8,
    total_tests: 10,
    total_cost_usd: 1.50,
    tier: 'e2e',
    tests: [],
    ...overrides,
  };
}

function makeShipLog(overrides: Record<string, unknown> = {}) {
  return {
    created_at: now,
    user_id: 'u1',
    email: 'alice@test.com',
    version: '0.3.10',
    branch: 'main',
    pr_url: 'https://github.com/org/repo/pull/1',
    ...overrides,
  };
}

function makeSession(overrides: Record<string, unknown> = {}) {
  return {
    started_at: now,
    ended_at: now,
    user_id: 'u1',
    email: 'alice@test.com',
    repo_slug: 'org/repo',
    total_turns: 10,
    tools_used: ['Edit', 'Bash'],
    summary: 'Did stuff',
    ...overrides,
  };
}

// --- detectRegressions ---

describe('detectRegressions', () => {
  test('returns empty for < 2 runs', () => {
    const result = detectRegressions([makeEvalRun()]);
    expect(result.regressions).toEqual([]);
    expect(result.overallDelta).toBe(0);
    expect(result.overallCurrentRate).toBeNull();
  });

  test('returns empty for empty array', () => {
    const result = detectRegressions([]);
    expect(result.regressions).toEqual([]);
  });

  test('detects overall regression', () => {
    const runs = [
      makeEvalRun({ passed: 5, total_tests: 10 }), // latest: 50%
      makeEvalRun({ passed: 9, total_tests: 10, timestamp: daysAgo(1) }), // prev: 90%
      makeEvalRun({ passed: 8, total_tests: 10, timestamp: daysAgo(2) }), // prev: 80%
    ];
    const result = detectRegressions(runs);
    expect(result.overallCurrentRate).toBe(50);
    expect(result.overallPreviousRate).toBe(85); // avg of 90 and 80
    expect(result.overallDelta).toBe(-35);
  });

  test('detects per-test regressions', () => {
    const runs = [
      makeEvalRun({ passed: 1, total_tests: 2, tests: [
        { name: 'test_a', passed: false },
        { name: 'test_b', passed: true },
      ]}),
      makeEvalRun({ passed: 2, total_tests: 2, timestamp: daysAgo(1), tests: [
        { name: 'test_a', passed: true },
        { name: 'test_b', passed: true },
      ]}),
      makeEvalRun({ passed: 2, total_tests: 2, timestamp: daysAgo(2), tests: [
        { name: 'test_a', passed: true },
        { name: 'test_b', passed: true },
      ]}),
    ];
    const result = detectRegressions(runs);
    expect(result.regressions.length).toBe(1);
    expect(result.regressions[0].testName).toBe('test_a');
    expect(result.regressions[0].previousRate).toBe(100);
    expect(result.regressions[0].currentRate).toBe(0);
  });

  test('handles total_tests = 0 gracefully', () => {
    const runs = [
      makeEvalRun({ passed: 0, total_tests: 0 }),
      makeEvalRun({ passed: 5, total_tests: 10, timestamp: daysAgo(1) }),
    ];
    const result = detectRegressions(runs);
    expect(result.overallCurrentRate).toBeNull();
    expect(result.overallDelta).toBe(0);
  });

  test('no regression when pass rate improves', () => {
    const runs = [
      makeEvalRun({ passed: 10, total_tests: 10 }), // 100%
      makeEvalRun({ passed: 5, total_tests: 10, timestamp: daysAgo(1) }), // 50%
    ];
    const result = detectRegressions(runs);
    expect(result.overallDelta).toBe(50);
    expect(result.regressions).toEqual([]);
  });
});

// --- computeVelocity ---

describe('computeVelocity', () => {
  test('groups ships by user', () => {
    const logs = [
      makeShipLog({ user_id: 'u1', email: 'alice@test.com', created_at: hoursAgo(1) }),
      makeShipLog({ user_id: 'u1', email: 'alice@test.com', created_at: hoursAgo(2) }),
      makeShipLog({ user_id: 'u2', email: 'bob@test.com', created_at: hoursAgo(3) }),
    ];
    const result = computeVelocity(logs);

    expect(result.teamTotal.week).toBe(3);
    expect(result.byUser.length).toBe(2);
    expect(result.byUser[0].email).toBe('alice@test.com');
    expect(result.byUser[0].shipsThisWeek).toBe(2);
    expect(result.byUser[1].email).toBe('bob@test.com');
    expect(result.byUser[1].shipsThisWeek).toBe(1);
  });

  test('separates week from month', () => {
    const logs = [
      makeShipLog({ created_at: hoursAgo(1) }),       // this week
      makeShipLog({ created_at: daysAgo(10) }),        // this month
      makeShipLog({ created_at: daysAgo(20) }),        // this month
    ];
    const result = computeVelocity(logs);

    expect(result.teamTotal.week).toBe(1);
    expect(result.teamTotal.month).toBe(3);
  });

  test('handles empty array', () => {
    const result = computeVelocity([]);
    expect(result.byUser).toEqual([]);
    expect(result.teamTotal).toEqual({ week: 0, month: 0 });
  });

  test('sorts by weekly ships descending', () => {
    const logs = [
      makeShipLog({ user_id: 'u1', created_at: hoursAgo(1) }),
      makeShipLog({ user_id: 'u2', created_at: hoursAgo(1) }),
      makeShipLog({ user_id: 'u2', created_at: hoursAgo(2) }),
      makeShipLog({ user_id: 'u2', created_at: hoursAgo(3) }),
    ];
    const result = computeVelocity(logs);
    expect(result.byUser[0].userId).toBe('u2');
    expect(result.byUser[0].shipsThisWeek).toBe(3);
  });
});

// --- computeCostTrend ---

describe('computeCostTrend', () => {
  test('groups costs by week', () => {
    const runs = [
      makeEvalRun({ total_cost_usd: 2.00, timestamp: '2026-03-16T12:00:00Z' }), // Mon
      makeEvalRun({ total_cost_usd: 3.00, timestamp: '2026-03-17T12:00:00Z' }), // Tue (same week)
      makeEvalRun({ total_cost_usd: 1.50, timestamp: '2026-03-08T12:00:00Z' }), // prev week
    ];
    const result = computeCostTrend(runs);

    expect(result.totalAllTime).toBe(6.50);
    expect(result.weekly.length).toBe(2);
    // Most recent week first
    const firstWeek = result.weekly[0];
    expect(firstWeek.runs).toBe(2);
    expect(firstWeek.totalCost).toBe(5.00);
  });

  test('handles empty array', () => {
    const result = computeCostTrend([]);
    expect(result.weekly).toEqual([]);
    expect(result.totalAllTime).toBe(0);
  });

  test('handles missing cost values', () => {
    const runs = [
      makeEvalRun({ total_cost_usd: undefined }),
      makeEvalRun({ total_cost_usd: null }),
    ];
    const result = computeCostTrend(runs);
    expect(result.totalAllTime).toBe(0);
  });
});

// --- computeLeaderboard ---

describe('computeLeaderboard', () => {
  test('aggregates across data sources', () => {
    const result = computeLeaderboard({
      evalRuns: [
        makeEvalRun({ user_id: 'u1', email: 'alice@test.com', passed: 8, total_tests: 10 }),
        makeEvalRun({ user_id: 'u1', email: 'alice@test.com', passed: 10, total_tests: 10 }),
      ],
      shipLogs: [
        makeShipLog({ user_id: 'u1', email: 'alice@test.com' }),
      ],
      sessions: [
        makeSession({ user_id: 'u1', email: 'alice@test.com' }),
        makeSession({ user_id: 'u1', email: 'alice@test.com' }),
      ],
    });

    expect(result.length).toBe(1);
    expect(result[0].email).toBe('alice@test.com');
    expect(result[0].ships).toBe(1);
    expect(result[0].evalRuns).toBe(2);
    expect(result[0].sessions).toBe(2);
    expect(result[0].avgPassRate).toBe(90); // avg of 80% and 100%
    expect(result[0].totalCost).toBe(3.00);
  });

  test('sorts by ships, then eval runs, then sessions', () => {
    const result = computeLeaderboard({
      evalRuns: [
        makeEvalRun({ user_id: 'u1', email: 'alice@test.com' }),
      ],
      shipLogs: [
        makeShipLog({ user_id: 'u2', email: 'bob@test.com' }),
        makeShipLog({ user_id: 'u2', email: 'bob@test.com' }),
      ],
      sessions: [],
    });

    expect(result[0].email).toBe('bob@test.com');
    expect(result[0].ships).toBe(2);
    expect(result[1].email).toBe('alice@test.com');
  });

  test('excludes data older than 7 days', () => {
    const result = computeLeaderboard({
      evalRuns: [
        makeEvalRun({ user_id: 'u1', timestamp: daysAgo(10) }),
      ],
      shipLogs: [
        makeShipLog({ user_id: 'u1', created_at: daysAgo(10) }),
      ],
      sessions: [
        makeSession({ user_id: 'u1', started_at: daysAgo(10) }),
      ],
    });

    expect(result.length).toBe(0);
  });

  test('handles all empty inputs', () => {
    const result = computeLeaderboard({
      evalRuns: [],
      shipLogs: [],
      sessions: [],
    });
    expect(result).toEqual([]);
  });

  test('handles eval runs with total_tests = 0', () => {
    const result = computeLeaderboard({
      evalRuns: [makeEvalRun({ passed: 0, total_tests: 0 })],
      shipLogs: [],
      sessions: [],
    });
    expect(result.length).toBe(1);
    expect(result[0].avgPassRate).toBeNull();
  });

  test('multiple users sorted correctly with ties', () => {
    const result = computeLeaderboard({
      evalRuns: [
        makeEvalRun({ user_id: 'u1', email: 'alice@test.com' }),
        makeEvalRun({ user_id: 'u2', email: 'bob@test.com' }),
      ],
      shipLogs: [
        makeShipLog({ user_id: 'u1', email: 'alice@test.com' }),
        makeShipLog({ user_id: 'u2', email: 'bob@test.com' }),
      ],
      sessions: [
        makeSession({ user_id: 'u1', email: 'alice@test.com' }),
        makeSession({ user_id: 'u1', email: 'alice@test.com' }),
        makeSession({ user_id: 'u2', email: 'bob@test.com' }),
      ],
    });

    // Same ships (1), same eval runs (1), u1 has more sessions
    expect(result[0].email).toBe('alice@test.com');
    expect(result[1].email).toBe('bob@test.com');
  });
});

// --- computeQATrend ---

describe('computeQATrend', () => {
  test('groups scores by repo', () => {
    const reports = [
      { repo_slug: 'org/app', health_score: 85, created_at: '2026-03-15T12:00:00Z' },
      { repo_slug: 'org/app', health_score: 90, created_at: '2026-03-14T12:00:00Z' },
      { repo_slug: 'org/api', health_score: 70, created_at: '2026-03-15T12:00:00Z' },
    ];
    const result = computeQATrend(reports);

    expect(result.byRepo.length).toBe(2);
    const app = result.byRepo.find(r => r.repoSlug === 'org/app')!;
    expect(app.scores.length).toBe(2);
    // Most recent first
    expect(app.scores[0].score).toBe(85);
    expect(app.scores[1].score).toBe(90);
  });

  test('handles empty array', () => {
    const result = computeQATrend([]);
    expect(result.byRepo).toEqual([]);
  });

  test('handles missing health_score', () => {
    const reports = [
      { repo_slug: 'org/app', health_score: null, created_at: '2026-03-15T12:00:00Z' },
    ];
    const result = computeQATrend(reports);
    expect(result.byRepo[0].scores[0].score).toBe(0);
  });
});

// --- computeEvalTrend ---

describe('computeEvalTrend', () => {
  test('computes per-test pass rates', () => {
    const runs = [
      makeEvalRun({ timestamp: '2026-03-15T12:00:00Z', tests: [
        { name: 'test_a', passed: true },
        { name: 'test_b', passed: false },
      ]}),
      makeEvalRun({ timestamp: '2026-03-14T12:00:00Z', tests: [
        { name: 'test_a', passed: true },
        { name: 'test_b', passed: true },
      ]}),
    ];
    const result = computeEvalTrend(runs);

    const testA = result.byTest.find(t => t.testName === 'test_a')!;
    expect(testA.passRate).toBe(100);
    expect(testA.isFlaky).toBe(false);

    const testB = result.byTest.find(t => t.testName === 'test_b')!;
    expect(testB.passRate).toBe(50);
  });

  test('detects flaky tests', () => {
    const runs = [
      makeEvalRun({ timestamp: '2026-03-15T12:00:00Z', tests: [{ name: 'flaky', passed: true }] }),
      makeEvalRun({ timestamp: '2026-03-14T12:00:00Z', tests: [{ name: 'flaky', passed: false }] }),
      makeEvalRun({ timestamp: '2026-03-13T12:00:00Z', tests: [{ name: 'flaky', passed: true }] }),
      makeEvalRun({ timestamp: '2026-03-12T12:00:00Z', tests: [{ name: 'flaky', passed: false }] }),
    ];
    const result = computeEvalTrend(runs);
    const flaky = result.byTest.find(t => t.testName === 'flaky')!;
    expect(flaky.isFlaky).toBe(true);
    expect(flaky.passRate).toBe(50);
  });

  test('sorts flaky first, then by worst pass rate', () => {
    const runs = [
      makeEvalRun({ tests: [
        { name: 'good', passed: true },
        { name: 'flaky', passed: true },
        { name: 'bad', passed: false },
      ]}),
      makeEvalRun({ timestamp: daysAgo(1), tests: [
        { name: 'good', passed: true },
        { name: 'flaky', passed: false },
        { name: 'bad', passed: false },
      ]}),
      makeEvalRun({ timestamp: daysAgo(2), tests: [
        { name: 'good', passed: true },
        { name: 'flaky', passed: true },
        { name: 'bad', passed: false },
      ]}),
    ];
    const result = computeEvalTrend(runs);

    // Flaky (50% pass rate, has both passes and failures across 3+ runs) should be first
    expect(result.byTest[0].testName).toBe('flaky');
    // Then bad (0%), then good (100%)
    expect(result.byTest[1].testName).toBe('bad');
    expect(result.byTest[2].testName).toBe('good');
  });

  test('handles empty array', () => {
    const result = computeEvalTrend([]);
    expect(result.byTest).toEqual([]);
  });

  test('handles tests without names', () => {
    const runs = [
      makeEvalRun({ tests: [{ passed: true }, { name: 'named', passed: true }] }),
    ];
    const result = computeEvalTrend(runs);
    expect(result.byTest.length).toBe(1);
    expect(result.byTest[0].testName).toBe('named');
  });

  test('history sorted ascending by timestamp', () => {
    const runs = [
      makeEvalRun({ timestamp: '2026-03-15T12:00:00Z', tests: [{ name: 'a', passed: true }] }),
      makeEvalRun({ timestamp: '2026-03-13T12:00:00Z', tests: [{ name: 'a', passed: false }] }),
      makeEvalRun({ timestamp: '2026-03-14T12:00:00Z', tests: [{ name: 'a', passed: true }] }),
    ];
    const result = computeEvalTrend(runs);
    const a = result.byTest.find(t => t.testName === 'a')!;
    // Should be sorted ascending: 13, 14, 15
    expect(a.history[0].timestamp).toContain('2026-03-13');
    expect(a.history[1].timestamp).toContain('2026-03-14');
    expect(a.history[2].timestamp).toContain('2026-03-15');
  });
});
