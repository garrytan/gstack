/**
 * Unit tests for two helpers added alongside the new real-PTY E2E tests:
 *
 *   - parseNumberedOptions(visible)
 *       Parses `❯ 1.` / `  2.` numbered-option lines out of TTY text.
 *       Used by the AskUserQuestion format-compliance and mode-routing tests to look
 *       up an option index by its label without hard-coding positions.
 *
 *   - findBudgetRegressions / assertNoBudgetRegression(comparison)
 *       Computes which tests grew >2× in tool calls or turns vs the prior
 *       eval run. Used by the budget-regression test.
 *
 * Free, deterministic, runs under `bun test`.
 */

import { describe, test, expect } from 'bun:test';
import { parseNumberedOptions } from './helpers/claude-pty-runner';
import {
  assertNoBudgetRegression,
  findBudgetRegressions,
  type ComparisonResult,
  type TestDelta,
} from './helpers/eval-store';

// --- parseNumberedOptions ---

describe('parseNumberedOptions', () => {
  test('returns [] for empty input', () => {
    expect(parseNumberedOptions('')).toEqual([]);
  });

  test('returns [] when no numbered list is rendered', () => {
    expect(parseNumberedOptions('just some prose with no list')).toEqual([]);
  });

  test('parses a basic 3-option list with cursor on first', () => {
    const visible = [
      'Some prompt prose above.',
      '',
      '❯ 1. HOLD SCOPE',
      '  2. SCOPE EXPANSION',
      '  3. SELECTIVE EXPANSION',
      '',
    ].join('\n');
    expect(parseNumberedOptions(visible)).toEqual([
      { index: 1, label: 'HOLD SCOPE' },
      { index: 2, label: 'SCOPE EXPANSION' },
      { index: 3, label: 'SELECTIVE EXPANSION' },
    ]);
  });

  test('parses cursor on a non-first option', () => {
    const visible = [
      '  1. Option A',
      '❯ 2. Option B',
      '  3. Option C',
    ].join('\n');
    const opts = parseNumberedOptions(visible);
    expect(opts.map(o => o.index)).toEqual([1, 2, 3]);
    expect(opts.map(o => o.label)).toEqual(['Option A', 'Option B', 'Option C']);
  });

  test('handles 9 options (max single-digit)', () => {
    const lines = ['❯ 1. one'];
    for (let i = 2; i <= 9; i++) lines.push(`  ${i}. opt${i}`);
    const opts = parseNumberedOptions(lines.join('\n'));
    expect(opts.length).toBe(9);
    expect(opts[8]).toEqual({ index: 9, label: 'opt9' });
  });

  test('truncates at first sequence gap', () => {
    // Real bug shape: prose contains "1. blah" and "2. blah" then a real
    // option list shows up later. We only return the consecutive run that
    // starts at 1.
    const visible = [
      '❯ 1. Real option',
      '  2. Other real option',
      'some prose',
      '  4. Stray number',
    ].join('\n');
    expect(parseNumberedOptions(visible)).toEqual([
      { index: 1, label: 'Real option' },
      { index: 2, label: 'Other real option' },
    ]);
  });

  test('returns [] when sequence does not start at 1', () => {
    const visible = ['  3. orphan', '  4. orphan'].join('\n');
    expect(parseNumberedOptions(visible)).toEqual([]);
  });

  test('returns [] for a single option (need at least 2 to be a real list)', () => {
    expect(parseNumberedOptions('❯ 1. lonely')).toEqual([]);
  });

  test('preserves trailing markers on labels (e.g. recommended)', () => {
    const visible = [
      '❯ 1. Cover all 4 modes (recommended)',
      '  2. Just HOLD + EXPANSION',
    ].join('\n');
    const opts = parseNumberedOptions(visible);
    expect(opts[0]!.label).toContain('(recommended)');
  });

  test('only matches the most recent list when buffer is large', () => {
    // First (stale) list, then >4KB of intervening text, then the real list.
    // parseNumberedOptions reads only the last 4KB, so the stale list is
    // dropped — this is the desired behavior for tests that re-open the
    // session and want the current prompt only.
    const stale = ['❯ 1. STALE_A', '  2. STALE_B'].join('\n');
    const filler = 'x'.repeat(5000);
    const fresh = ['❯ 1. FRESH_A', '  2. FRESH_B'].join('\n');
    const visible = stale + '\n' + filler + '\n' + fresh;
    const opts = parseNumberedOptions(visible);
    expect(opts.map(o => o.label)).toEqual(['FRESH_A', 'FRESH_B']);
  });

  test('anchors on LAST cursor when both stale and fresh fit in the tail', () => {
    // Both lists fit in the same 4KB tail (small buffer). The granted
    // permission dialog options come first, the real AskUserQuestion comes second.
    // We must return the FRESH options, not the STALE ones.
    const visible = [
      '❯ 1. STALE_grant',
      '  2. STALE_deny',
      'some narration the agent printed after we granted',
      'and a few more lines of bash output',
      '❯ 1. FRESH_keep',
      '  2. FRESH_drop',
    ].join('\n');
    const opts = parseNumberedOptions(visible);
    expect(opts.map(o => o.label)).toEqual(['FRESH_keep', 'FRESH_drop']);
  });

  test('falls back to last `1.` if cursor is not currently rendered on option 1', () => {
    // The user pressed Down, so cursor is on option 2; but the parser
    // should still return options 1+2 by anchoring on the last `1.` line.
    const visible = [
      '  1. Option A',
      '❯ 2. Option B',
      '  3. Option C',
    ].join('\n');
    const opts = parseNumberedOptions(visible);
    expect(opts.map(o => o.label)).toEqual(['Option A', 'Option B', 'Option C']);
  });
});

// --- findBudgetRegressions / assertNoBudgetRegression ---

function makeDelta(
  name: string,
  beforeTools: Record<string, number>,
  afterTools: Record<string, number>,
  beforeTurns?: number,
  afterTurns?: number,
): TestDelta {
  return {
    name,
    before: { passed: true, cost_usd: 0, tool_summary: beforeTools, turns_used: beforeTurns },
    after:  { passed: true, cost_usd: 0, tool_summary: afterTools,  turns_used: afterTurns  },
    status_change: 'unchanged',
  };
}

function makeComparison(deltas: TestDelta[]): ComparisonResult {
  return {
    before_file: '/tmp/before.json',
    after_file: '/tmp/after.json',
    before_branch: 'main',
    after_branch: 'feat/x',
    before_timestamp: '2025-01-01T00:00:00Z',
    after_timestamp: '2025-01-02T00:00:00Z',
    deltas,
    total_cost_delta: 0,
    total_duration_delta: 0,
    improved: 0,
    regressed: 0,
    unchanged: deltas.length,
    tool_count_before: 0,
    tool_count_after: 0,
  };
}

describe('findBudgetRegressions', () => {
  test('empty comparison → no regressions', () => {
    expect(findBudgetRegressions(makeComparison([]))).toEqual([]);
  });

  test('no regression when after ≤ 2× before for tools', () => {
    const c = makeComparison([
      makeDelta('a', { Bash: 10 }, { Bash: 19 }), // 1.9× — under cap
    ]);
    expect(findBudgetRegressions(c)).toEqual([]);
  });

  test('flags >2× tool growth', () => {
    const c = makeComparison([
      makeDelta('a', { Bash: 10, Read: 5 }, { Bash: 25, Read: 12 }), // 15→37 = 2.47×
    ]);
    const regs = findBudgetRegressions(c);
    expect(regs.length).toBe(1);
    expect(regs[0]!.metric).toBe('tools');
    expect(regs[0]!.before).toBe(15);
    expect(regs[0]!.after).toBe(37);
  });

  test('flags >2× turn growth independently of tools', () => {
    const c = makeComparison([
      makeDelta('a', { Bash: 10 }, { Bash: 12 }, 5, 15), // turns 5→15 = 3×
    ]);
    const regs = findBudgetRegressions(c);
    expect(regs.length).toBe(1);
    expect(regs[0]!.metric).toBe('turns');
  });

  test('skips tests with no prior tool data (new test)', () => {
    const c = makeComparison([
      makeDelta('new-test', {}, { Bash: 100 }), // no prior — should not flag
    ]);
    expect(findBudgetRegressions(c)).toEqual([]);
  });

  test('skips when prior tool count is below the floor (noise floor)', () => {
    // 1 → 4 tools is 4× ratio but meaningless on tiny numbers.
    const c = makeComparison([
      makeDelta('tiny', { Bash: 1 }, { Bash: 4 }),
    ]);
    expect(findBudgetRegressions(c)).toEqual([]);
  });

  test('respects ratioCap override', () => {
    const c = makeComparison([
      makeDelta('a', { Bash: 10 }, { Bash: 16 }), // 1.6×
    ]);
    expect(findBudgetRegressions(c, { ratioCap: 1.5 }).length).toBe(1);
    expect(findBudgetRegressions(c, { ratioCap: 2.0 }).length).toBe(0);
  });

  test('respects GSTACK_BUDGET_RATIO env override', () => {
    const c = makeComparison([
      makeDelta('a', { Bash: 10 }, { Bash: 16 }), // 1.6×
    ]);
    const prev = process.env.GSTACK_BUDGET_RATIO;
    try {
      process.env.GSTACK_BUDGET_RATIO = '1.5';
      expect(findBudgetRegressions(c).length).toBe(1);
      process.env.GSTACK_BUDGET_RATIO = '2.0';
      expect(findBudgetRegressions(c).length).toBe(0);
    } finally {
      if (prev === undefined) delete process.env.GSTACK_BUDGET_RATIO;
      else process.env.GSTACK_BUDGET_RATIO = prev;
    }
  });

  test('handles missing tool_summary gracefully', () => {
    const delta: TestDelta = {
      name: 'sparse',
      before: { passed: true, cost_usd: 0 },
      after:  { passed: true, cost_usd: 0 },
      status_change: 'unchanged',
    };
    expect(findBudgetRegressions(makeComparison([delta]))).toEqual([]);
  });
});

describe('assertNoBudgetRegression', () => {
  test('does not throw on a clean comparison', () => {
    const c = makeComparison([
      makeDelta('a', { Bash: 10 }, { Bash: 11 }),
    ]);
    expect(() => assertNoBudgetRegression(c)).not.toThrow();
  });

  test('throws with all violations and the cap value in the message', () => {
    const c = makeComparison([
      makeDelta('regressed-tools', { Bash: 10 }, { Bash: 30 }),
      makeDelta('regressed-turns', { Bash: 5 }, { Bash: 6 }, 4, 13),
    ]);
    let err: Error | null = null;
    try {
      assertNoBudgetRegression(c);
    } catch (e) {
      err = e as Error;
    }
    expect(err).not.toBeNull();
    expect(err!.message).toContain('regressed-tools');
    expect(err!.message).toContain('regressed-turns');
    expect(err!.message).toContain('2.00×'); // default cap
    expect(err!.message).toContain('GSTACK_BUDGET_RATIO');
  });
});
