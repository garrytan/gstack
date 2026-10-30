/**
 * gstack-ship-preflight (GSTA-167 PR 4): /ship Steps 1-3 and Step 5's pregate and lanes in
 * one command. These are the checks Steps 1-3 and 5 used to spell out as shell blocks,
 * moved into the bin; each STOP is a place the prose leaves the decision to the agent.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { lineOf, PREFLIGHT, shipFixture, type ShipFx } from './helpers/ship-bin-fixture';

setDefaultTimeout(60_000);
const fixtures: ShipFx[] = [];
const fx = (...a: Parameters<typeof shipFixture>) => { const f = shipFixture(...a); fixtures.push(f); return f; };
afterEach(() => { while (fixtures.length) fixtures.pop()!.cleanup(); });
const LANE = 'tests=printf " 3 pass\\n 0 fail\\nRan 3 tests across 1 file. [5.00ms]\\n"';

describe('gstack-ship-preflight', () => {
  // Value: protects=one call reports branch, diff, PR, merge, policy, runtime lines, pregate and each lane with its count, in at most 30 lines; fails_when=a step is skipped, a lane passes on exit 0 alone, or the output grows past the cap;
  //   why_new=the preflight bin is new; seam=gstack-evidence, gstack-pregate, gstack-review-plan; no_claim=project test selection
  test('a clean branch: Steps 1-3 then the pregate and one counted lane, NEXT Step 6, at most 30 lines', () => {
    const f = fx();
    const r = f.run(PREFLIGHT, ['--base', 'main', '--lane', LANE]);
    expect(r.status).toBe(0);
    for (const key of ['BRANCH', 'STATUS', 'DIFF', 'PR', 'SCOPE', 'MERGE', 'DISTRIBUTION', 'POLICY', 'RUNTIME_LINES', 'PREGATE']) expect(lineOf(r.stdout, key)).not.toBe('');
    expect(lineOf(r.stdout, 'MERGE')).toBe('MERGE: up to date');
    expect(lineOf(r.stdout, 'RUNTIME_LINES')).toMatch(/^RUNTIME_LINES: 1 /);
    expect(lineOf(r.stdout, 'LANE')).toMatch(/^LANE: tests pass exit=0 tests_ran=3 log=/);
    expect(r.stdout).toContain('NEXT: Step 6');
    expect(r.stdout.trimEnd().split('\n').length).toBeLessThanOrEqual(30);
  });

  // Value: protects=Step 1's base-branch abort and Step 1.3's fetch failure stop before anything else runs; fails_when=preflight merges or tests on the base branch or after a failed fetch;
  //   why_new=moved from the Step 1 prose; seam=none; no_claim=recovery
  test('on the base branch, or when the fetch fails, it stops before merging', () => {
    const f = fx();
    f.git('checkout', '-q', 'main');
    const onBase = f.run(PREFLIGHT, ['--base', 'main']);
    expect(onBase.status).toBe(3);
    expect(onBase.stdout).toContain('STOP: on the base branch (main)');
    f.git('checkout', '-q', 'feat');
    f.git('remote', 'set-url', 'origin', path.join(f.root, 'missing.git'));
    const fetch = f.run(PREFLIGHT, ['--base', 'main']);
    expect(fetch.status).toBe(3);
    expect(fetch.stdout).toContain('STOP: git fetch origin main failed');
    expect(fetch.stdout).not.toContain('MERGE:');
  });

  // Value: protects=Step 3 merges the base and a conflict stops with the files named, leaving the merge for the agent to resolve; fails_when=the bin resolves a conflict itself, aborts the merge, or continues to tests;
  //   why_new=moved from the Step 3 prose; seam=git merge; no_claim=which side is right
  test('a merged base is reported; a conflict stops with the conflicted files and the merge left in place', () => {
    const f = fx();
    f.advanceBase({ 'docs/new.md': '# new\n' });
    expect(lineOf(f.run(PREFLIGHT, ['--base', 'main']).stdout, 'MERGE')).toMatch(/^MERGE: merged origin\/main at [0-9a-f]{12}$/);
    const g = fx({}, { 'src/a.ts': 'export const a = 2;\n' });
    g.advanceBase({ 'src/a.ts': 'export const a = 3;\n' });
    const r = g.run(PREFLIGHT, ['--base', 'main', '--lane', LANE]);
    expect(r.status).toBe(3);
    expect(r.stdout).toMatch(/STOP: merge conflicts in src\/a\.ts: resolve simple ones .* ask \(Step 3\)/);
    expect(fs.existsSync(path.join(g.work, '.git', 'MERGE_HEAD'))).toBe(true);
    expect(r.stdout).not.toContain('LANE:');
  });

  // Value: protects=a failing lane and a zero-run lane both stop for Step 5's triage; fails_when=exit 0 with zero tests counts as a pass, or a failure continues to Step 6;
  //   why_new=moved from Step 5's lane block; seam=gstack-evidence tests_ran; no_claim=the triage outcome
  test('a failing lane and a ZERO-RUN lane stop for Step 5 triage', () => {
    const f = fx();
    const failed = f.run(PREFLIGHT, ['--tests-only', '--base', 'main', '--lane', 'tests=echo boom; exit 1']);
    expect(failed.status).toBe(3);
    expect(lineOf(failed.stdout, 'LANE')).toMatch(/^LANE: tests FAIL exit=1/);
    expect(failed.stdout).toContain('Step 5 triage');
    const zero = f.run(PREFLIGHT, ['--tests-only', '--base', 'main', '--lane', 'tests=printf " 0 pass\\n 0 fail\\nRan 0 tests across 1 file. [5.00ms]\\n"']);
    expect(zero.status).toBe(3);
    expect(lineOf(zero.stdout, 'LANE')).toMatch(/^LANE: tests ZERO-RUN exit=0 tests_ran=0/);
  });

  // Value: protects=Step 2's candidates and Step 1.4's carry check are reported for the agent to judge, and an open PR's carry verdict is printed; fails_when=a new bin/ artifact goes unmentioned or the carry check is skipped when a PR is open;
  //   why_new=moved from Steps 1.4 and 2; seam=gh, gstack-ship-receipt carry; no_claim=whether a candidate is a distributable
  test('a new artifact path is a Step 2 candidate; an open PR runs the carry dry-run and prints its verdict', () => {
    const f = fx({}, { 'bin/fx-tool': '#!/bin/sh\necho hi\n' });
    f.gh('echo 7');
    const r = f.run(PREFLIGHT, ['--base', 'main']);
    expect(lineOf(r.stdout, 'DISTRIBUTION')).toBe('DISTRIBUTION: candidates=bin/fx-tool release_workflow=none');
    expect(r.stdout).toContain("NEXT: Step 2: read each candidate");
    expect(lineOf(r.stdout, 'PR')).toBe('PR: #7');
    expect(lineOf(r.stdout, 'CARRY')).toMatch(/^CARRY: /);
    expect(r.stdout).toContain('NEXT: Step 4');
  });

  test('usage: --base is required and --tests-only needs a lane', () => {
    const f = fx();
    expect(f.run(PREFLIGHT, []).status).toBe(2);
    expect(f.run(PREFLIGHT, ['--tests-only', '--base', 'main']).status).toBe(2);
    expect(f.run(PREFLIGHT, ['--base', 'main', '--lane', 'nolabel']).status).toBe(2);
  });
});
