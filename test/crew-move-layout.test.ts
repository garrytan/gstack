/**
 * Crew-only modules live under crew/ (crew/README.md). Each one left the root
 * tree whole: its old path is gone, its crew/ path exists, and the test-code
 * typecheck still covers crew/test.
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dir, '..');

const MOVED: Array<[string, string]> = [
  ['lib/gate-cost-history.ts', 'crew/lib/gate-cost-history.ts'],
  ['lib/gate-cost.ts', 'crew/lib/gate-cost.ts'],
  ['lib/lane-ownership.ts', 'crew/lib/lane-ownership.ts'],
  ['lib/release-gate.ts', 'crew/lib/release-gate.ts'],
  ['lib/restamp-release.ts', 'crew/lib/restamp-release.ts'],
  ['lib/ship-queue-dispatch-ci.ts', 'crew/lib/ship-queue-dispatch-ci.ts'],
  ['lib/ship-queue-gate.ts', 'crew/lib/ship-queue-gate.ts'],
  ['lib/ship-queue-land-lock.ts', 'crew/lib/ship-queue-land-lock.ts'],
  ['lib/ship-queue-post-merge.ts', 'crew/lib/ship-queue-post-merge.ts'],
  ['lib/ship-queue-screen.ts', 'crew/lib/ship-queue-screen.ts'],
  ['lib/ship-queue-stack-tests.ts', 'crew/lib/ship-queue-stack-tests.ts'],
  ['lib/ship-queue-train-cli.ts', 'crew/lib/ship-queue-train-cli.ts'],
  ['lib/ship-queue-train-forget.ts', 'crew/lib/ship-queue-train-forget.ts'],
  ['lib/ship-queue-train-gate.ts', 'crew/lib/ship-queue-train-gate.ts'],
  ['lib/ship-queue-train-github.ts', 'crew/lib/ship-queue-train-github.ts'],
  ['lib/ship-queue-train-init.ts', 'crew/lib/ship-queue-train-init.ts'],
  ['lib/ship-queue-train-land.ts', 'crew/lib/ship-queue-train-land.ts'],
  ['lib/ship-queue-train-ready.ts', 'crew/lib/ship-queue-train-ready.ts'],
  ['lib/ship-queue-train-record.ts', 'crew/lib/ship-queue-train-record.ts'],
  ['lib/ship-queue-train-stamp.ts', 'crew/lib/ship-queue-train-stamp.ts'],
  ['lib/ship-queue-train-verdict.ts', 'crew/lib/ship-queue-train-verdict.ts'],
  ['lib/ship-queue-train-verify.ts', 'crew/lib/ship-queue-train-verify.ts'],
  ['lib/ship-queue-train-watch.ts', 'crew/lib/ship-queue-train-watch.ts'],
  ['lib/ship-queue-train.ts', 'crew/lib/ship-queue-train.ts'],
  ['lib/ship-queue-wave.ts', 'crew/lib/ship-queue-wave.ts'],
  ['lib/ship-recheck.ts', 'crew/lib/ship-recheck.ts'],
  ['lib/version-gate-train.ts', 'crew/lib/version-gate-train.ts'],
  ['scripts/census-arms.ts', 'crew/scripts/census-arms.ts'],
  ['scripts/eval-input-cache.ts', 'crew/scripts/eval-input-cache.ts'],
  ['scripts/gate-cost-replay.ts', 'crew/scripts/gate-cost-replay.ts'],
  ['scripts/gate-diff-calibrate.ts', 'crew/scripts/gate-diff-calibrate.ts'],
  ['scripts/gate-reuse.ts', 'crew/scripts/gate-reuse.ts'],
  ['scripts/judge-calibration-configs.ts', 'crew/scripts/judge-calibration-configs.ts'],
  ['scripts/measure-journal-read.ts', 'crew/scripts/measure-journal-read.ts'],
  ['scripts/recover-receipts.ts', 'crew/scripts/recover-receipts.ts'],
  ['scripts/release-cadence.ts', 'crew/scripts/release-cadence.ts'],
  ['scripts/release-cut.ts', 'crew/scripts/release-cut.ts'],
  ['scripts/replay-pr-selection.ts', 'crew/scripts/replay-pr-selection.ts'],
  ['scripts/review-dispatch-compare.ts', 'crew/scripts/review-dispatch-compare.ts'],
  ['scripts/train-backstop.ts', 'crew/scripts/train-backstop.ts'],
  ['scripts/train-gate.ts', 'crew/scripts/train-gate.ts'],
];

describe('crew-only modules moved into crew/', () => {
  test.each(MOVED)('%s now lives at %s', (from, to) => {
    expect(fs.existsSync(path.join(ROOT, from))).toBe(false);
    expect(fs.existsSync(path.join(ROOT, to))).toBe(true);
  });

  test('tsconfig.test.json typechecks crew/test', () => {
    const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'tsconfig.test.json'), 'utf8'));
    expect(config.include).toContain('crew/test/**/*.ts');
  });
});
