/**
 * Tests for computeTrends() — per-test pass rate trend tracking.
 */

import { describe, test, expect } from 'bun:test';
import { computeTrends } from '../lib/cli-eval';
import type { EvalResult } from './helpers/eval-store';

/** Build a minimal EvalResult with given tests. */
function makeRun(opts: {
  timestamp: string;
  tier?: 'e2e' | 'llm-judge';
  tests: Array<{ name: string; passed: boolean }>;
}): EvalResult {
  return {
    schema_version: 1,
    version: '0.3.3',
    branch: 'main',
    git_sha: 'abc',
    timestamp: opts.timestamp,
    hostname: 'test',
    tier: opts.tier || 'e2e',
    total_tests: opts.tests.length,
    passed: opts.tests.filter(t => t.passed).length,
    failed: opts.tests.filter(t => !t.passed).length,
    total_cost_usd: 0,
    total_duration_ms: 0,
    tests: opts.tests.map(t => ({
      name: t.name, suite: 'test', tier: opts.tier || 'e2e' as const,
      passed: t.passed, duration_ms: 0, cost_usd: 0,
    })),
  };
}

describe('computeTrends', () => {
  test('classifies stable-pass test correctly', () => {
    // 10 runs all passing — results are newest-first (loadEvalResults order)
    const results = Array.from({ length: 10 }, (_, i) => makeRun({
      timestamp: `2026-03-${String(10 + i).padStart(2, '0')}T00:00:00Z`,
      tests: [{ name: 'always-pass', passed: true }],
    })).reverse(); // newest first

    const trends = computeTrends(results);
    expect(trends).toHaveLength(1);
    expect(trends[0].status).toBe('stable-pass');
    expect(trends[0].passRate).toBe(1);
    expect(trends[0].streak).toEqual({ type: 'pass', count: 10 });
    expect(trends[0].flipCount).toBe(0);
  });

  test('classifies stable-fail test correctly', () => {
    const results = Array.from({ length: 10 }, (_, i) => makeRun({
      timestamp: `2026-03-${String(10 + i).padStart(2, '0')}T00:00:00Z`,
      tests: [{ name: 'always-fail', passed: false }],
    })).reverse();

    const trends = computeTrends(results);
    expect(trends[0].status).toBe('stable-fail');
    expect(trends[0].passRate).toBe(0);
    expect(trends[0].streak).toEqual({ type: 'fail', count: 10 });
  });

  test('classifies flaky test correctly — alternating pass/fail', () => {
    const results = Array.from({ length: 10 }, (_, i) => makeRun({
      timestamp: `2026-03-${String(10 + i).padStart(2, '0')}T00:00:00Z`,
      tests: [{ name: 'flaky', passed: i % 2 === 0 }],
    })).reverse();

    const trends = computeTrends(results);
    expect(trends[0].status).toBe('flaky');
    expect(trends[0].flipCount).toBe(9);
    expect(trends[0].passRate).toBe(0.5);
  });

  test('classifies improving test correctly', () => {
    // First 5 fail, last 5 pass
    const results = Array.from({ length: 10 }, (_, i) => makeRun({
      timestamp: `2026-03-${String(10 + i).padStart(2, '0')}T00:00:00Z`,
      tests: [{ name: 'improving', passed: i >= 5 }],
    })).reverse();

    const trends = computeTrends(results);
    expect(trends[0].status).toBe('improving');
    expect(trends[0].streak).toEqual({ type: 'pass', count: 5 });
  });

  test('classifies degrading test correctly', () => {
    // First 7 pass, last 3 fail
    const results = Array.from({ length: 10 }, (_, i) => makeRun({
      timestamp: `2026-03-${String(10 + i).padStart(2, '0')}T00:00:00Z`,
      tests: [{ name: 'degrading', passed: i < 7 }],
    })).reverse();

    const trends = computeTrends(results);
    expect(trends[0].status).toBe('degrading');
    expect(trends[0].streak).toEqual({ type: 'fail', count: 3 });
  });

  test('computes streak correctly with mixed ending', () => {
    // pass, pass, fail, pass, pass, pass (newest)
    const passed = [true, true, false, true, true, true];
    const results = passed.map((p, i) => makeRun({
      timestamp: `2026-03-${String(10 + i).padStart(2, '0')}T00:00:00Z`,
      tests: [{ name: 'test', passed: p }],
    })).reverse();

    const trends = computeTrends(results);
    expect(trends[0].streak).toEqual({ type: 'pass', count: 3 });
  });

  test('computes flipCount correctly', () => {
    // pass, fail, pass, pass, fail, pass → 4 flips
    const passed = [true, false, true, true, false, true];
    const results = passed.map((p, i) => makeRun({
      timestamp: `2026-03-${String(10 + i).padStart(2, '0')}T00:00:00Z`,
      tests: [{ name: 'test', passed: p }],
    })).reverse();

    const trends = computeTrends(results);
    expect(trends[0].flipCount).toBe(4);
  });

  test('handles single run', () => {
    const results = [makeRun({
      timestamp: '2026-03-15T00:00:00Z',
      tests: [{ name: 'single', passed: true }],
    })];

    const trends = computeTrends(results);
    expect(trends).toHaveLength(1);
    expect(trends[0].passRate).toBe(1);
    expect(trends[0].streak).toEqual({ type: 'pass', count: 1 });
    expect(trends[0].flipCount).toBe(0);
    expect(trends[0].status).toBe('stable-pass');
  });

  test('handles single failing run', () => {
    const results = [makeRun({
      timestamp: '2026-03-15T00:00:00Z',
      tests: [{ name: 'single-fail', passed: false }],
    })];

    const trends = computeTrends(results);
    expect(trends[0].status).toBe('stable-fail');
  });

  test('filters by tier', () => {
    const results = [
      makeRun({ timestamp: '2026-03-15T00:00:00Z', tier: 'e2e', tests: [{ name: 'e2e-test', passed: true }] }),
      makeRun({ timestamp: '2026-03-15T00:00:00Z', tier: 'llm-judge', tests: [{ name: 'judge-test', passed: true }] }),
    ];

    const e2eOnly = computeTrends(results, 'e2e');
    expect(e2eOnly).toHaveLength(1);
    expect(e2eOnly[0].name).toBe('e2e-test');

    const judgeOnly = computeTrends(results, 'llm-judge');
    expect(judgeOnly).toHaveLength(1);
    expect(judgeOnly[0].name).toBe('judge-test');
  });

  test('filters by test name', () => {
    const results = Array.from({ length: 3 }, (_, i) => makeRun({
      timestamp: `2026-03-${String(10 + i).padStart(2, '0')}T00:00:00Z`,
      tests: [
        { name: 'test-a', passed: true },
        { name: 'test-b', passed: false },
      ],
    })).reverse();

    const filtered = computeTrends(results, undefined, 'test-a');
    expect(filtered).toHaveLength(1);
    expect(filtered[0].name).toBe('test-a');
    expect(filtered[0].passRate).toBe(1);
  });

  test('sorts flaky tests first', () => {
    // Create runs where test-a is flaky and test-b is stable
    const results = Array.from({ length: 6 }, (_, i) => makeRun({
      timestamp: `2026-03-${String(10 + i).padStart(2, '0')}T00:00:00Z`,
      tests: [
        { name: 'test-a', passed: i % 2 === 0 }, // flaky: alternating
        { name: 'test-b', passed: true },          // stable-pass
      ],
    })).reverse();

    const trends = computeTrends(results);
    expect(trends[0].name).toBe('test-a');
    expect(trends[0].status).toBe('flaky');
    expect(trends[1].name).toBe('test-b');
    expect(trends[1].status).toBe('stable-pass');
  });
});
