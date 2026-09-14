/**
 * Detach-timeout floor — free, gate-tier tripwire.
 *
 * The eval:bg:gate / eval:bg:periodic scripts wrap the sharded paid runner in
 * bin/gstack-detach with a hard --timeout. If that number dips below the
 * runner's worst-case wall clock — ordinary waves plus registered excess — the
 * watchdog kills a healthy run mid-flight and the tail shards report
 * never-started: paid truncation by configuration. That nearly shipped once
 * (a review pass proposed 10800s against a 19,800s gate worst case), so the
 * bound is enforced here against the LIVE shard census instead of a comment
 * snapshot that goes stale every time a paid test file is added.
 *
 * If this test fails you have two honest options: raise the --timeout in the
 * package.json script it names, or reduce the tier's worst case (split fewer
 * files per shard, raise DEFAULT_JOBS after verifying API rate headroom).
 */

import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import {
  collectPaidTestFiles,
  selectPaidTestFiles,
  DEFAULT_JOBS,
  DEFAULT_SHARD_TIMEOUT_MS,
  resolvePaidShardBudget,
  type PaidTier,
} from '../scripts/test-paid-shards';
import { AUTOPLAN_CHAIN_BUDGET } from './helpers/eval-budgets';

const ROOT = path.resolve(import.meta.dir, '..');
// 5% margin over the theoretical bound: detach setup, lock wait, aggregation.
const MARGIN = 1.05;

function detachTimeoutSeconds(scriptName: string): number {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8'));
  const script: string | undefined = pkg.scripts?.[scriptName];
  expect(script, `package.json is missing the "${scriptName}" script`).toBeTruthy();
  const m = script!.match(/--timeout\s+(\d+)/);
  expect(m, `"${scriptName}" has no gstack-detach --timeout flag`).toBeTruthy();
  return parseInt(m![1], 10);
}

function worstCaseSeconds(files: string[], jobs = DEFAULT_JOBS): number {
  // The equal-wall bound still covers ordinary work. Add every positive excess
  // conservatively: a registered long file can delay its worker and all later
  // jobs. Do not divide the excess by jobs, which can underbudget one long tail.
  const excessMs = files.reduce((sum, file) =>
    sum + Math.max(0, resolvePaidShardBudget([file]).timeoutMs - DEFAULT_SHARD_TIMEOUT_MS), 0);
  return (Math.ceil(files.length / jobs) * DEFAULT_SHARD_TIMEOUT_MS + excessMs) / 1000;
}


describe('eval:bg detach timeouts cover the sharded runner worst case', () => {
  for (const [tier, script] of [
    ['gate', 'eval:bg:gate'],
    ['periodic', 'eval:bg:periodic'],
  ] as Array<[PaidTier, string]>) {
    test(`${script} covers ordinary ${tier} waves plus registered excess x ${MARGIN}`, () => {
      const files = selectPaidTestFiles(collectPaidTestFiles(), tier).selected;
      expect(files.length).toBeGreaterThan(0);
      const floor = Math.ceil(worstCaseSeconds(files) * MARGIN);
      const configured = detachTimeoutSeconds(script);
      if (configured < floor) {
        throw new Error(
          `${script} --timeout ${configured}s is below the ${tier} tier's worst-case ` +
          `wall clock of ${floor}s (ceil(shards/${DEFAULT_JOBS} jobs) x ` +
          `${DEFAULT_SHARD_TIMEOUT_MS / 1000}s ordinary wall + registered excess, x ${MARGIN} margin). ` +
          `An undersized detach watchdog kills healthy runs mid-flight and the tail ` +
          `shards report never-started. Raise the --timeout in package.json or reduce ` +
          `the tier's worst case.`,
        );
      }
    });
  }
});

// One long job and one ordinary job can run side by side; the long job still
// needs its whole wall, regardless of the number of ordinary workers.
test('a heterogeneous pair rejects the old uniform-wall floor', () => {
  const pair = [AUTOPLAN_CHAIN_BUDGET.file, 'test/skill-e2e-other.test.ts'];
  const actualLongest = Math.max(...pair.map(file => resolvePaidShardBudget([file]).timeoutMs)) / 1000;
  expect(worstCaseSeconds(pair, 2)).toBe(actualLongest);
  expect(worstCaseSeconds(pair, 2)).toBeGreaterThan(DEFAULT_SHARD_TIMEOUT_MS / 1000);
  expect(worstCaseSeconds(pair, 1)).toBe(pair.reduce((sum, file) => sum + resolvePaidShardBudget([file]).timeoutMs / 1000, 0));
  expect(worstCaseSeconds(['test/a.test.ts', 'test/b.test.ts'], 2)).toBe(DEFAULT_SHARD_TIMEOUT_MS / 1000);
});
