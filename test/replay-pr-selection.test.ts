/** CEO-23 replay logic on fixture inputs: misses, retired cases and the fallback-rate summary. */
import { describe, expect, test } from 'bun:test';
import { caseTouchesDiff, replayRun, summarize, type ReplayInput } from '../scripts/replay-pr-selection';

const input = (over: Partial<ReplayInput>): ReplayInput => ({ runId: 1, oldMode: 'full-fallback', oldCases: 90, changedFiles: [],
  truncated: false, failedCases: [], packageVersionOnly: false, ...over });

describe('PR selection replay (CEO-23)', () => {
  test('a durations-only push no longer falls back, and a failure unrelated to the diff is not a miss', () => {
    const row = replayRun(input({ changedFiles: ['scripts/paid-test-durations.json'], failedCases: ['qa-only-no-fix'] }), ['qa-only-no-fix']);
    expect(row.newMode).toBe('pr');
    expect(row.misses).toEqual([]);
    expect(row.dropped).toEqual(['qa-only-no-fix']);
    expect(caseTouchesDiff('qa-only-no-fix', ['scripts/paid-test-durations.json'])).toBe(false);
  });

  test('a failed profile case whose dependency changed stays selected; retired cases are counted apart', () => {
    const row = replayRun(input({ changedFiles: ['qa/SKILL.md.tmpl'], failedCases: ['qa-bootstrap', 'retired-case-x'] }), []);
    expect(caseTouchesDiff('qa-bootstrap', ['qa/SKILL.md.tmpl'])).toBe(true);
    expect(row.misses).toEqual([]);
    expect(row.retiredFailures).toEqual(['retired-case-x']);
  });

  test('a failed gate case the PR profile defers is reported as a miss, never hidden', () => {
    const row = replayRun(input({ changedFiles: ['qa-only/SKILL.md.tmpl'], failedCases: ['qa-only-no-fix'] }), []);
    expect(row.newMode).toBe('pr');
    expect(row.misses).toEqual(['qa-only-no-fix']);
  });

  test('the summary reports both fallback rates and lists every miss', () => {
    const lines = summarize([
      { runId: 1, oldMode: 'full-fallback', newMode: 'pr', oldCases: 90, newCases: 3, dropped: [], misses: [], retiredFailures: [], truncated: false, changed: 4, vanished: 0 },
      { runId: 2, oldMode: 'full-fallback', newMode: 'full-fallback', oldCases: 90, newCases: 90, dropped: [], misses: ['x'], retiredFailures: ['y'], truncated: true, changed: 300, vanished: 2 },
    ]).join('\n');
    expect(lines).toContain('full-fallback: 2 (100%) recorded -> 1 (50%) replayed');
    expect(lines).toContain('MISSES (failed, depends on the diff, not selected now): 1 -> 2:x');
    expect(lines).toContain("300-file limit: 1");
    expect(lines).toContain('no longer exist: 1');
    expect(lines).toContain('wave branches (diff >= 100 files): 1 push(es); full-fallback 1 recorded -> 1 (100%) replayed');
    expect(lines).toContain('ordinary pushes (diff < 100 files): 1 push(es); full-fallback 1 recorded -> 0 (0%) replayed; dependents 0, pr 1; median selected gate cases 3');
    expect(lines).toContain("missing from today's tree: 1");
  });
});
