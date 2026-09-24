/**
 * Unit tests for the flake-rank aggregator (WS1's dial). The CLI ranks tests
 * by retried passes (the flake signature) across finalized eval-store runs —
 * these pin the accounting: N attempt records = 1 run of that test, the
 * FINAL attempt decides pass/fail, retried passes count separately, partials
 * and runner artifacts are excluded, shard dirs recurse, and the recency
 * bound drops stale files.
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { aggregate, collectEvalFiles } from '../scripts/eval-flake-rank';
import { manualReviewFixture } from './helpers/manual-judge-review-fixture';

const entry = (name: string, passed: boolean, attempt: number) => ({
  name, suite: 's', tier: 'e2e', passed, attempt, duration_ms: 1000, cost_usd: 0.1,
});

const run = (tests: object[], extra: object = {}) => JSON.stringify({
  schema_version: 2, version: '1.0.0', branch: 'b', git_sha: 'x', hostname: 'h',
  timestamp: '2026-08-31T00:00:00Z', tier: 'e2e',
  total_tests: tests.length, passed: 0, failed: 0, total_cost_usd: 0, total_duration_ms: 0,
  tests, ...extra,
});

describe('eval-flake-rank aggregate', () => {
  test('manual acceptance is visible but not a scored failure or retried pass', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flakerank-manual-'));
    const manual = manualReviewFixture();
    const { manual_review: _receipt, ...ordinary } = manual;
    fs.writeFileSync(path.join(dir, 'prior.json'), run([{ ...ordinary, passed: true, exit_reason: 'success',
      judge_scores: { clarity: 4, completeness: 3, actionability: 4 } }]));
    fs.writeFileSync(path.join(dir, 'accepted.json'), run([manual]));
    const series = aggregate(collectEvalFiles(dir)).get(manual.name);
    expect(series).toMatchObject({ runs: 1, passes: 1, fails: 0, manualAccepted: 1,
      retriedPasses: 0, totalAttempts: 2 });
    const display = spawnSync(process.execPath, [path.resolve(import.meta.dir, '../scripts/eval-flake-rank.ts'), '--dir', dir],
      { encoding: 'utf8', timeout: 10_000 });
    expect(display.status, display.stderr).toBe(0);
    expect(display.stdout).toContain('fails/runs  manual');
    expect(display.stdout).toContain('0/1');
    expect(display.stdout).toContain(manual.name);
    fs.writeFileSync(path.join(dir, 'invalid-retry.json'), run([
      { ...ordinary, attempt: 1 }, { ...manual, attempt: 2 },
    ]));
    expect(aggregate(collectEvalFiles(dir)).get(manual.name)).toMatchObject({ runs: 2, passes: 1,
      fails: 1, manualAccepted: 1, retriedPasses: 0 });
    fs.writeFileSync(path.join(dir, 'invalid-pass.json'), run([{ ...manual, passed: true }]));
    expect(aggregate(collectEvalFiles(dir)).get(manual.name)).toMatchObject({ runs: 3, passes: 1,
      fails: 2, manualAccepted: 1, retriedPasses: 0 });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('final attempt decides; retried pass counts as retriedPass, not a fail', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flakerank-'));
    fs.writeFileSync(path.join(dir, 'run1.json'), run([
      entry('flaky', false, 1), entry('flaky', true, 2),   // pass on retry
      entry('steady', true, 1),
      entry('broken', false, 1), entry('broken', false, 2), // fails even retried
    ]));
    fs.writeFileSync(path.join(dir, 'run2.json'), run([
      entry('flaky', true, 1), entry('steady', true, 1),
    ]));
    const series = aggregate(collectEvalFiles(dir));
    expect(series.get('flaky')).toMatchObject({ runs: 2, passes: 2, fails: 0, retriedPasses: 1, totalAttempts: 3 });
    expect(series.get('steady')).toMatchObject({ runs: 2, passes: 2, fails: 0, retriedPasses: 0 });
    expect(series.get('broken')).toMatchObject({ runs: 1, passes: 0, fails: 1, retriedPasses: 0, totalAttempts: 2 });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('partials and runner artifacts are excluded; shard dirs recurse', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flakerank-'));
    fs.mkdirSync(path.join(dir, 'shards', 'slug-a'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'shards', 'slug-a', 'run.json'), run([entry('sharded', true, 1)]));
    fs.writeFileSync(path.join(dir, '_partial-e2e.json'), run([entry('inflight', false, 1)], { _partial: true }));
    fs.writeFileSync(path.join(dir, 'manifest.json'), '{"version":1}');
    fs.writeFileSync(path.join(dir, 'slice-3.json'), '{"version":1}');
    const files = collectEvalFiles(dir);
    expect(files).toHaveLength(1);
    const series = aggregate(files);
    expect(series.has('sharded')).toBe(true);
    expect(series.has('inflight')).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('recency bound drops files older than sinceDays', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flakerank-'));
    const stale = path.join(dir, 'old.json');
    fs.writeFileSync(stale, run([entry('ancient', true, 1)]));
    const old = new Date(Date.now() - 90 * 86_400_000);
    fs.utimesSync(stale, old, old);
    fs.writeFileSync(path.join(dir, 'new.json'), run([entry('recent', true, 1)]));
    const files = collectEvalFiles(dir, 60);
    expect(files.map((f) => path.basename(f))).toEqual(['new.json']);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
