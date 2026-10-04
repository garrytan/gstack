/**
 * W2c / ENG-2: per-slice CI job ceilings and the executor's in-process slice
 * deadline. A wedged slice fails within max(2x budget, longest shard wall,
 * overlay envelope) + setup instead of holding a runner for the sum of every
 * shard's worst case; shards that cannot start become explicit not_run
 * records (INFRA), shards killed in flight read as hung (TIMEOUT), and a job
 * that ends before its final write still reports from its last checkpoint.
 */
import { describe, expect, test } from 'bun:test';
import {
  CI_SETUP_ALLOWANCE_MINUTES,
  DEFAULT_SHARD_TIMEOUT_MS,
  OVERLAY_MAX_ACTIVE_SHARDS,
  SLICE_UPLOAD_RESERVE_MS,
  infraOnly,
  resolvePaidShardTimeoutMs,
  runPaidShards,
  sliceCiTimeoutMinutes,
  sliceDeadlineMs,
  verifySliceResults,
  type PaidRunManifest,
  type ShardOutcome,
  type SliceResult,
} from '../scripts/test-paid-shards';
import { OVERLAY_MIN_FILE_WALL_MS } from './helpers/overlay-case-policy';

const minutes = (ms: number) => ms / 60_000;
const OVERLAY = ['test/skill-e2e-overlay-harness-a.test.ts', 'test/skill-e2e-overlay-harness-b.test.ts'];

describe('per-slice CI job ceiling', () => {
  test('the longest single shard wall dominates a slice of ordinary shards', () => {
    const files = ['test/a.test.ts', 'test/b.test.ts', 'test/c.test.ts', 'test/d.test.ts'];
    expect(sliceCiTimeoutMinutes(files, 420_000, 2))
      .toBe(Math.ceil(minutes(DEFAULT_SHARD_TIMEOUT_MS)) + CI_SETUP_ALLOWANCE_MINUTES);
  });

  test('twice the slice budget dominates when every shard wall is shorter', () => {
    expect(sliceCiTimeoutMinutes(['test/a.test.ts'], 20 * 60_000, 2, 5 * 60_000)).toBe(40 + CI_SETUP_ALLOWANCE_MINUTES);
  });

  test('the serialized overlay group is its own slice envelope', () => {
    expect(OVERLAY_MAX_ACTIVE_SHARDS).toBe(1);
    expect(sliceCiTimeoutMinutes(OVERLAY, 420_000, 2))
      .toBe(Math.ceil(minutes(2 * OVERLAY_MIN_FILE_WALL_MS)) + CI_SETUP_ALLOWANCE_MINUTES);
    expect(resolvePaidShardTimeoutMs([OVERLAY[0]!])).toBe(OVERLAY_MIN_FILE_WALL_MS);
  });

  test('the deadline is the job start plus the ceiling minus the upload reserve', () => {
    expect(SLICE_UPLOAD_RESERVE_MS).toBe(5 * 60_000);
    expect(sliceDeadlineMs(50, '1700000000', 9)).toBe(1_700_000_000_000 + 50 * 60_000 - SLICE_UPLOAD_RESERVE_MS);
    for (const unrecorded of [undefined, '', 'soon', '-3']) {
      expect(sliceDeadlineMs(50, unrecorded, 1_000)).toBe(1_000 + 50 * 60_000 - SLICE_UPLOAD_RESERVE_MS);
    }
  });
});

describe('in-process slice deadline', () => {
  const sleeper = () => ({ command: process.execPath, args: ['-e', 'setTimeout(() => {}, 60_000)'] });

  test('multiple slow shards: the running one is killed as hung, the rest never start (not_run)', async () => {
    const checkpoints: ShardOutcome[][] = [];
    const summary = await runPaidShards([['slow-1'], ['slow-2'], ['slow-3']], {
      timeoutMs: 30_000, jobs: 1, commandFor: sleeper, log: () => {},
      sliceDeadlineMs: Date.now() + 1_500, onProgress: snapshot => checkpoints.push(snapshot),
    });
    const [first, second, third] = summary.outcomes;
    expect(first).toMatchObject({ status: 'timed-out', sliceDeadline: 'hung' });
    expect(first!.elapsedMs).toBeLessThan(20_000);
    expect(second).toMatchObject({ status: 'never-started', sliceDeadline: 'not_run' });
    expect(third).toMatchObject({ status: 'never-started', sliceDeadline: 'not_run' });
    // While the first shard ran, a checkpoint already rendered it hung and the rest not_run.
    expect(checkpoints[0]!.map(outcome => [outcome.status, outcome.sliceDeadline]))
      .toEqual([['timed-out', 'hung'], ['never-started', 'not_run'], ['never-started', 'not_run']]);
  }, 30_000);

  test('a trial shard that never starts keeps an INFRA-shaped trial record', async () => {
    const key = 'test/skill-e2e-x.test.ts#case-x~t1';
    const plan = { kind: 'behavior' as const, panel: { n: 3, k: 2 }, quarantined: false };
    const summary = await runPaidShards([[key]], {
      timeoutMs: 30_000, jobs: 1, commandFor: () => { throw new Error('must never launch'); }, log: () => {},
      trials: { [key]: plan }, sliceDeadlineMs: Date.now() - 1,
    });
    expect(summary.outcomes[0]).toMatchObject({ status: 'never-started', sliceDeadline: 'not_run' });
    expect(summary.outcomes[0]!.trial).toMatchObject({ case: 'case-x', trial: 1, outcome: null, harness: 'never started' });
  });
});

describe('report reconciliation of deadline outcomes', () => {
  const manifest: PaidRunManifest = {
    version: 1, tier: 'periodic', evalsAll: true, sliceCount: 1, selectionReason: 'fixture',
    entries: ['test/done.test.ts', 'test/hung.test.ts', 'test/later.test.ts'].map(file => ({ file, slice: 1, status: 'planned' as const })),
  };
  const result = (outcomes: SliceResult['outcomes'], checkpoint = false): SliceResult => ({
    version: 1, tier: 'periodic', sliceIndex: 1, sliceCount: 1, ...(checkpoint ? { checkpoint: true as const } : {}), outcomes });
  const done = { files: ['test/done.test.ts'], status: 'passed' as const, exitCode: 0, elapsedMs: 9, executedTests: 1, skippedTests: 0 };
  const hung = { files: ['test/hung.test.ts'], status: 'timed-out' as const, exitCode: null, elapsedMs: 9, executedTests: null, skippedTests: null, sliceDeadline: 'hung' as const };
  const notRun = { files: ['test/later.test.ts'], status: 'never-started' as const, exitCode: null, elapsedMs: 0, executedTests: null, skippedTests: null, sliceDeadline: 'not_run' as const };

  test('not_run alone is INFRA; a hung shard is a TIMEOUT that keeps the lane red', () => {
    const notRunOnly = verifySliceResults(manifest, [result([done, { ...hung, status: 'passed', exitCode: 0, executedTests: 1, skippedTests: 0, sliceDeadline: undefined }, notRun])]);
    expect(notRunOnly.problems).toEqual(['test/later.test.ts (not_run: the slice deadline passed before it started): never-started']);
    expect(infraOnly(notRunOnly.problems)).toBe(true);
    const withHung = verifySliceResults(manifest, [result([done, hung, notRun])]);
    expect(withHung.problems).toContain('test/hung.test.ts (hung: killed at the slice deadline): timed-out');
    expect(infraOnly(withHung.problems)).toBe(false);
  });

  test('a slice job that timed out renders from its checkpoint as TIMEOUT plus not_run, never as a missing slice', () => {
    const verdict = verifySliceResults(manifest, [result([done, hung, notRun], true)]);
    expect(verdict.ok).toBe(false);
    expect(verdict.problems).toEqual([
      'slice 1/1 ended before its final result (job ceiling or cancellation); its outcomes come from the last checkpoint: TIMEOUT',
      'test/hung.test.ts (hung: killed at the slice deadline): timed-out',
      'test/later.test.ts (not_run: the slice deadline passed before it started): never-started',
    ]);
    expect(verdict.problems.some(problem => problem.includes('reported NO result'))).toBe(false);
  });
});
