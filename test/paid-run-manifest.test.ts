/**
 * Planner/executor/report contract for the re-platformed paid CI lane.
 *
 * The classes these pin (each was a live CI failure mode of the old
 * hand-enumerated matrix, or a review-identified risk of the migration):
 *  - per-slice selector divergence → ONE planner manifest, executors consume
 *  - hollow lanes → a slice with no artifact is a FAILURE, not an absence
 *  - hollow shards → EVALS_ALL + exit 0 + zero executed tests ≠ pass
 *  - retry parity → the old matrix rows' earned `retries: 2` survive as a
 *    literals map, not folklore
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  applyHollowShardGuard,
  buildPaidShardArgs,
  buildRunManifest,
  parseRunManifest,
  retriesForFiles,
  RETRY_OVERRIDES,
  summarize,
  summaryExitCode,
  verifySliceResults,
  type PaidRunManifest,
  type ShardOutcome,
  type SliceResult,
} from '../scripts/test-paid-shards';

const ROOT = path.resolve(__dirname, '..');

const outcome = (over: Partial<ShardOutcome>): ShardOutcome => ({
  shard: 1,
  files: ['test/skill-e2e-x.test.ts'],
  status: 'passed',
  exitCode: 0,
  elapsedMs: 1000,
  groupPid: null,
  executedTests: 3,
  ...over,
});

describe('run manifest (planner)', () => {
  test('live build: every paid file appears exactly once; planned slices partition 1..K', () => {
    const manifest = buildRunManifest({ tier: 'gate', sliceCount: 5, evalsAll: true, env: { EVALS_ALL: '1' } });
    const files = manifest.entries.map((e) => e.file);
    expect(new Set(files).size).toBe(files.length);
    const planned = manifest.entries.filter((e) => e.status === 'planned');
    expect(planned.length).toBeGreaterThan(20); // census sanity
    for (const entry of planned) {
      expect(entry.slice).toBeGreaterThanOrEqual(1);
      expect(entry.slice).toBeLessThanOrEqual(5);
    }
    // Round-robin balance: slice sizes differ by at most 1.
    const sizes = [1, 2, 3, 4, 5].map((i) => planned.filter((e) => e.slice === i).length);
    expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1);
    // Non-runnable entries carry slice 0 and a reason.
    for (const entry of manifest.entries.filter((e) => e.status !== 'planned')) {
      expect(entry.slice).toBe(0);
      expect(entry.reason ?? '').not.toBe('');
    }
  });

  test('deterministic for identical inputs', () => {
    const opts = { tier: 'periodic' as const, sliceCount: 4, evalsAll: true, env: { EVALS_ALL: '1' } };
    expect(buildRunManifest(opts)).toEqual(buildRunManifest(opts));
  });

  test('parse round-trips and rejects malformed manifests', () => {
    // EVALS_ALL short-circuits diff selection BEFORE any git walk: selection
    // is deliberately fail-closed on git errors, and CI's shallow free-tests
    // checkout has no base ref (first CI run failed here with
    // "ambiguous argument 'main...HEAD'").
    const manifest = buildRunManifest({ tier: 'gate', sliceCount: 2, evalsAll: false, env: { EVALS_ALL: '1' } });
    expect(parseRunManifest(JSON.stringify(manifest))).toEqual(manifest);
    expect(() => parseRunManifest('{}')).toThrow(/version/);
    expect(() => parseRunManifest(JSON.stringify({ ...manifest, tier: 'e2e' }))).toThrow(/tier/);
    expect(() => parseRunManifest(JSON.stringify({ ...manifest, sliceCount: 0 }))).toThrow(/sliceCount/);
    const outOfRange = {
      ...manifest,
      entries: [{ file: 'test/skill-e2e-x.test.ts', slice: 9, status: 'planned' }],
    };
    expect(() => parseRunManifest(JSON.stringify(outOfRange))).toThrow(/out-of-range/);
  });
});

describe('slice-result reconciliation (report)', () => {
  const manifest: PaidRunManifest = {
    version: 1,
    tier: 'gate',
    evalsAll: false,
    sliceCount: 2,
    selectionReason: 'test fixture',
    entries: [
      { file: 'test/skill-e2e-a.test.ts', slice: 1, status: 'planned' },
      { file: 'test/skill-e2e-b.test.ts', slice: 2, status: 'planned' },
      { file: 'test/skill-e2e-c.test.ts', slice: 0, status: 'skipped-by-diff', reason: 'unselected' },
    ],
  };
  const slice = (index: number, files: string[], status: ShardOutcome['status'] = 'passed'): SliceResult => ({
    version: 1,
    tier: 'gate',
    sliceIndex: index,
    sliceCount: 2,
    outcomes: files.map((f) => ({ files: [f], status, exitCode: 0, elapsedMs: 5, executedTests: 2 })),
  });

  test('all slices present and passing → ok', () => {
    const verdict = verifySliceResults(manifest, [
      slice(1, ['test/skill-e2e-a.test.ts']),
      slice(2, ['test/skill-e2e-b.test.ts']),
    ]);
    expect(verdict).toEqual({ ok: true, problems: [] });
  });

  test('a missing slice artifact is a FAILURE, not an absence', () => {
    const verdict = verifySliceResults(manifest, [slice(1, ['test/skill-e2e-a.test.ts'])]);
    expect(verdict.ok).toBe(false);
    expect(verdict.problems.join('\n')).toContain('slice 2/2 reported NO result');
  });

  test('a planned shard nobody reported fails even when its slice reported', () => {
    const verdict = verifySliceResults(manifest, [
      slice(1, []),
      slice(2, ['test/skill-e2e-b.test.ts']),
    ]);
    expect(verdict.ok).toBe(false);
    expect(verdict.problems.join('\n')).toContain('never reported');
  });

  test('wrong-slice, duplicate, cross-tier, and failing outcomes all surface', () => {
    const wrongSlice = verifySliceResults(manifest, [
      slice(1, ['test/skill-e2e-b.test.ts']),
      slice(2, ['test/skill-e2e-a.test.ts']),
    ]);
    expect(wrongSlice.ok).toBe(false);
    const failing = verifySliceResults(manifest, [
      slice(1, ['test/skill-e2e-a.test.ts'], 'failed'),
      slice(2, ['test/skill-e2e-b.test.ts']),
    ]);
    expect(failing.problems.join('\n')).toContain('test/skill-e2e-a.test.ts: failed');
    const crossTier = verifySliceResults(manifest, [
      { ...slice(1, ['test/skill-e2e-a.test.ts']), tier: 'periodic' },
      slice(2, ['test/skill-e2e-b.test.ts']),
    ]);
    expect(crossTier.problems.join('\n')).toContain('ran tier periodic');
  });
});

describe('hollow-shard guard', () => {
  test('EVALS_ALL: passed with 0 executed tests becomes passed-empty and fails the run', () => {
    const guarded = applyHollowShardGuard([outcome({ executedTests: 0 })], { evalsAll: true, warn: () => {} });
    expect(guarded[0].status).toBe('passed-empty');
    const summary = summarize(guarded);
    expect(summary.failed).toBe(1);
    expect(summaryExitCode(summary)).toBe(1);
  });

  test('selective run: same shape stays passed, warns once', () => {
    const warnings: string[] = [];
    const guarded = applyHollowShardGuard([outcome({ executedTests: 0 })], {
      evalsAll: false, warn: (line) => warnings.push(line),
    });
    expect(guarded[0].status).toBe('passed');
    expect(warnings).toHaveLength(1);
  });

  test('unknown executedTests (null) is never guessed hollow', () => {
    const guarded = applyHollowShardGuard([outcome({ executedTests: null })], { evalsAll: true });
    expect(guarded[0].status).toBe('passed');
  });
});

describe('retry parity', () => {
  test('overrides exist only for the files whose matrix rows earned them, and each names a real file', () => {
    expect(Object.keys(RETRY_OVERRIDES).sort()).toEqual([
      'test/skill-e2e-office-hours-auto-mode.test.ts',
      'test/skill-e2e-plan-mode-no-op.test.ts',
      'test/skill-e2e-workflow.test.ts',
    ]);
    for (const file of Object.keys(RETRY_OVERRIDES)) {
      expect(fs.existsSync(path.join(ROOT, file)), `stale RETRY_OVERRIDES entry: ${file}`).toBe(true);
    }
    expect(retriesForFiles(['test/skill-e2e-workflow.test.ts'])).toBe(2);
    expect(retriesForFiles(['test/skill-e2e-retro.test.ts'])).toBe(1);
    expect(buildPaidShardArgs(['x'], 1000, 4, 2)).toContain('2');
    expect(buildPaidShardArgs(['x'], 1000, 4).join(' ')).toContain('--retry 1');
  });
});
