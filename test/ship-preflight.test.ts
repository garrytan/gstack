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

  // Value: protects=the default-branch abort reads the remote's HEAD, not a local origin/HEAD a clone pointed at the feature branch; fails_when=a checkout whose local origin/HEAD names the feature branch is refused as "on the base branch";
  //   why_new=GSTA-167 dogfood on #3633: a Capy checkout's origin/HEAD is the PR branch; seam=git ls-remote --symref; no_claim=offline fallback
  test('a local origin/HEAD naming the feature branch is not the default branch', () => {
    const f = fx();
    f.git('update-ref', 'refs/remotes/origin/feat', 'HEAD');
    f.git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/feat');
    const r = f.run(PREFLIGHT, ['--base', 'main']);
    expect(r.stdout).not.toContain('STOP: on the base branch');
    expect(r.status).toBe(0);
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

  // Value: protects=under queue_mode stamp-at-merge /ship never merges the base into the branch (docs/ship-policy.md#ship-before-ready; the slot stamp does), and DIFF counts only the branch's own change; fails_when=the preflight merges main anyway or DIFF counts the base's movement;
  //   why_new=GSTA-167 dogfood on #3633 hit the merge under stamp-at-merge; seam=gstack-ship-policy show-effective; no_claim=the slot stamp's merge
  test('queue_mode stamp-at-merge: the base is not merged and DIFF is the branch alone', () => {
    const f = fx({ '.gstack/ship-policy.json': '{"queue_mode":"stamp-at-merge"}\n' });
    f.advanceBase({ 'docs/new.md': '# new\n' });
    const head = f.git('rev-parse', 'HEAD').stdout.trim();
    const r = f.run(PREFLIGHT, ['--base', 'main']);
    expect(r.status).toBe(0);
    expect(lineOf(r.stdout, 'MERGE')).toMatch(/^MERGE: skipped \(queue_mode stamp-at-merge/);
    expect(f.git('rev-parse', 'HEAD').stdout.trim()).toBe(head);
    expect(lineOf(r.stdout, 'DIFF')).toMatch(/^DIFF: 1 file changed, 1 insertion\(\+\); commits=1$/);
    expect(lineOf(r.stdout, 'POLICY')).toContain('queue_mode=stamp-at-merge');
  });

  // Value: protects=Step 1's scope check reads the fetched origin/<base>, so a clone without a local base branch still sees frontend files; fails_when=the preflight reports frontend=false because gstack-diff-scope could not resolve a local <base>;
  //   why_new=GSTA-167 dogfood on #3633: a Capy checkout has no local main and SCOPE printed false; seam=gstack-diff-scope; no_claim=design review itself
  test('no local base branch: SCOPE still reads the fetched base', () => {
    const f = fx({}, { 'web/site.css': 'a { color: red; }\n' });
    f.git('branch', '-D', 'main');
    const r = f.run(PREFLIGHT, ['--base', 'main']);
    expect(lineOf(r.stdout, 'SCOPE')).toMatch(/^SCOPE: frontend=true /);
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

  // Value: protects=the branch name reaches gh as one argv item, never through a shell; fails_when=a branch named with $(...) runs a command on the shipper's machine;
  //   why_new=GSTA-167 /ship review of #3633 (security, CRITICAL); seam=gh; no_claim=gh's own handling of the name
  test('a branch name with shell syntax is never executed', () => {
    const f = fx();
    const name = 'x$(touch${IFS}PWNED)';
    expect(f.git('checkout', '-qb', name).status).toBe(0);
    f.gh('echo 7');
    f.run(PREFLIGHT, ['--base', 'main']);
    expect(fs.existsSync(path.join(f.work, 'PWNED'))).toBe(false);
  });

  // Value: protects=a local-path origin skips the open-PR and carry checks with a reason instead of asking gh, which cannot map it to a repository (and fails outright under a GH_HOST); fails_when=gh runs against a local remote and CARRY reports a GH_HOST failure;
  //   why_new=GSTA-167 replay 3 of gstack-evals #34 (CARRY: not checked, GH_HOST); seam=gh; no_claim=hosted remotes, which gh resolves itself
  test('a local-path origin is not checked by gh', () => {
    const f = fx();
    f.gh('echo "none of the git remotes configured for this repository correspond to the GH_HOST environment variable" >&2; exit 1');
    f.git('config', 'remote.origin.url', f.origin);
    const local = f.run(PREFLIGHT, ['--base', 'main'], { GH_HOST: 'ghe.example.com' });
    expect(lineOf(local.stdout, 'PR')).toMatch(/^PR: not checked \(origin is a local path/);
    expect(local.stdout).not.toContain('CARRY:');
    expect(local.status).toBe(0);
  });

  // Value: protects=RUNTIME_LINES (the small-run delegation input) counts code lines the way the packets classify paths, leaving data files out; fails_when=a JSON attachment inflates the runtime count;
  //   why_new=GSTA-167 replay 3 of gstack-evals #34 (RUNTIME_LINES 6687 counted JSON); seam=gstack-review-plan --json per_path; no_claim=the review depth's own count
  test('RUNTIME_LINES leaves data files out', () => {
    const f = fx({}, { 'src/b.ts': 'export const b = 2;\n', 'data/rows.json': Array.from({ length: 100 }, (_, i) => `{"i":${i}}`).join('\n') + '\n' });
    expect(lineOf(f.run(PREFLIGHT, ['--base', 'main']).stdout, 'RUNTIME_LINES')).toMatch(/^RUNTIME_LINES: 1 /);
  });

  test('usage: --base is required and --tests-only needs a lane', () => {
    const f = fx();
    expect(f.run(PREFLIGHT, []).status).toBe(2);
    expect(f.run(PREFLIGHT, ['--tests-only', '--base', 'main']).status).toBe(2);
    expect(f.run(PREFLIGHT, ['--base', 'main', '--lane', 'nolabel']).status).toBe(2);
  });
});

// lib/ship-audit.ts: the --audit mode's logic.
describe('gstack-ship-preflight --audit (GSTA-167 variant G)', () => {
  // Value: protects=one call writes the diff and the matching TODOS.md items to files the parent reads instead of TODOS.md and the diff, maps changed runtime files to tests, and names the audit readers still needed; fails_when=the diff or TODOS.md comes back whole, an untested runtime file is called covered, a changed test is missed, or a changed docs/designs/ plan is not offered;
  //   why_new=the --audit mode is new (GSTA-185: TODOS.md read in full twice and the diff three times per run); seam=git, gstack-slug; no_claim=coverage quality beyond file names
  test('writes diff and todos files, maps coverage, and prints READER for the coverage and plan audits', () => {
    const todos = '# TODOS\n\n## Ship\n- fix budget rounding in src/budget.ts\n- an unrelated item\n\n## Other\n- nothing here\n';
    const f = fx({ 'TODOS.md': todos }, { 'src/budget.ts': 'export const budget = 1;\n', 'src/other.ts': 'export const o = 1;\n', 'test/budget.test.ts': "import { budget } from '../src/budget';\n" });
    const out = path.join(f.root, 'audit');
    const r = f.run(PREFLIGHT, ['--audit', '--base', 'main', '--out', out], { HOME: f.root });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(lineOf(r.stdout, 'CONTEXT')).toMatch(new RegExp(`^CONTEXT: diff=${out}/diff.patch bytes=\\d+ files=3 commits=1 `));
    expect(fs.readFileSync(path.join(out, 'diff.patch'), 'utf8')).toContain('+export const o = 1;');
    expect(lineOf(r.stdout, 'TODOS')).toMatch(/^TODOS: bytes=\d+ hits=1 file=/);
    expect(fs.readFileSync(path.join(out, 'todos.md'), 'utf8')).toBe('## Ship\n- fix budget rounding in src/budget.ts\n');
    expect(r.stdout).not.toContain('an unrelated item');
    expect(r.stdout).toContain('COVERAGE_MAP: src/budget.ts changed_tests=1 referencing_tests=1');
    expect(r.stdout).toContain('COVERAGE_MAP: src/other.ts changed_tests=0 referencing_tests=0');
    expect(r.stdout).toContain('Coverage: 1 of 2 changed runtime files have no changed test naming them (src/other.ts)');
    expect(r.stdout).toContain('Plan completion audit: not run (no plan is bound to this branch');
    expect(lineOf(r.stdout, 'READER')).toBe('READER: coverage=needed plan=none');
  });

  // Value: protects=a branch whose runtime files all have changed tests skips the coverage reader, and a changed docs/designs/ plan asks for the plan reader; fails_when=the coverage reader runs on a fully tested diff, or a branch's design doc is not a candidate;
  //   why_new=the --audit mode is new; seam=git; no_claim=that the plan is the right one
  test('a fully tested diff needs no coverage reader; a changed design doc needs the plan reader', () => {
    const f = fx({}, { 'src/budget.ts': 'export const budget = 1;\n', 'test/budget.test.ts': "import { budget } from '../src/budget';\n", 'docs/designs/budget.md': '# Plan\n' });
    const r = f.run(PREFLIGHT, ['--audit', '--base', 'main', '--out', path.join(f.root, 'audit')], { HOME: f.root });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain('Coverage: deterministic (each of 1 changed runtime files has a changed test naming it; no audit reader)');
    expect(r.stdout).toContain('PLAN_CANDIDATE: docs/designs/budget.md');
    expect(lineOf(r.stdout, 'READER')).toBe('READER: coverage=none plan=needed');
    expect(f.run(PREFLIGHT, ['--audit', '--base', 'main']).status).toBe(2);
  });
});

describe('GSTA-167 part 4a: RUNTIME_LINES and REVIEW_DEPTH share one owner', () => {
  // Value: protects=preflight's RUNTIME_LINES equals gstack-review-plan's runtime_lines on a mixed diff (code, a data file code
  //   names, one nothing names, config JSON, YAML); fails_when=the two counts disagree, as preflight's own DATA_PATH did; seam=classifyDiff
  test('a mixed diff counts the same runtime lines in preflight and the review plan', () => {
    const f = fx({}, {
      'src/b.ts': 'export const b = 2;\n', 'src/load.ts': "export const u = 'used.json';\n", 'data/used.json': '[1,\n2,\n3]\n',
      'data/rows.json': Array.from({ length: 100 }, (_, i) => `{"i":${i}}`).join('\n') + '\n', 'config/app.json': '{"a":1}\n', 'deploy.yaml': 'a: 1\nb: 2\n',
    });
    const preflight = lineOf(f.run(PREFLIGHT, ['--base', 'main']).stdout, 'RUNTIME_LINES');
    const plan = JSON.parse(f.run(path.join(path.dirname(PREFLIGHT), 'gstack-review-plan'), ['--base', 'main', '--json', '--gate-tagged', '0']).stdout);
    expect(plan.runtime_lines).toBe(1 + 1 + 3 + 1 + 2);
    expect(preflight).toMatch(new RegExp(`^RUNTIME_LINES: ${plan.runtime_lines} `));
    expect(plan.consumed).toEqual(['data/used.json']);
  });
});

describe('gstack-ship-preflight Step 5 pregate: head policy and timeout_s (GST-419, GST-420)', () => {
  const POLICY = { runner: 'node --test {files}', dependencies: { 'README.md': [], 'CHANGELOG.md': [] } };
  const PASSING = "const test = require('node:test');\ntest('x', () => {});\n";
  const base = (extra: Record<string, unknown> = {}) => ({ '.gstack/pregate.json': JSON.stringify({ ...POLICY, ...extra }) + '\n', 'test/x.test.js': PASSING });
  // Value: protects=a branch that adds the lane for a file it touches passes Step 5 through preflight with --policy-from head; fails_when=preflight drops the flag and pregate reports PREGATE_NO_LANE;
  //   why_new=GEVA-2 (gstack-evals#93) had to call runLanes by hand; seam=gstack-pregate --policy-from head; no_claim=queue treatment of head records
  test('--policy-from head reaches pregate: the branch lane counts, and without the flag PREGATE_DETAIL names the missing lane', () => {
    const f = fx(base(), { 'src/a.ts': 'export const a = 2;\n', '.gstack/pregate.json': JSON.stringify({ ...POLICY, dependencies: { ...POLICY.dependencies, 'src/a.ts': ['test/x.test.js'] } }) + '\n' });
    const viaBase = f.run(PREFLIGHT, ['--tests-only', '--base', 'main', '--lane', LANE]);
    expect(viaBase.status).toBe(3);
    expect(lineOf(viaBase.stdout, 'PREGATE_DETAIL')).toContain('with no test lane: src/a.ts');
    expect(lineOf(viaBase.stdout, 'PREGATE_DETAIL')).toContain('(PREGATE_NO_LANE');
    const viaHead = f.run(PREFLIGHT, ['--tests-only', '--base', 'main', '--policy-from', 'head', '--lane', LANE]);
    expect(lineOf(viaHead.stdout, 'PREGATE')).toMatch(/^PREGATE: pass/);
    expect(viaHead.status).toBe(0);
    expect(lineOf(viaHead.stdout, 'LANE')).toMatch(/^LANE: tests pass /);
  });

  // Value: protects=the head-policy rule holds through preflight: a head policy that removes a lane is refused and named; fails_when=preflight passes or hides the refusal as unreadable;
  //   why_new=preflight now forwards --policy-from; seam=PREGATE_HEAD_POLICY_LOOSENS; no_claim=none
  test('--policy-from head with a head policy that removes a lane stops with PREGATE_HEAD_POLICY_LOOSENS', () => {
    const f = fx(base(), { 'src/a.ts': 'export const a = 2;\n', '.gstack/pregate.json': JSON.stringify({ ...POLICY, dependencies: { 'src/a.ts': ['test/x.test.js'] } }) + '\n' });
    const r = f.run(PREFLIGHT, ['--tests-only', '--base', 'main', '--policy-from', 'head', '--lane', LANE]);
    expect(r.status).toBe(3);
    expect(lineOf(r.stdout, 'PREGATE')).toBe('PREGATE: refused (PREGATE_HEAD_POLICY_LOOSENS)');
    expect(lineOf(r.stdout, 'PREGATE_DETAIL')).toContain('dependencies["README.md"] is removed');
    expect(r.stdout).not.toContain('LANE: tests');
  });

  // Value: protects=the repo's timeout_s reaches preflight's pregate and the cause is printed; fails_when=preflight's pregate runs at the 600 s default or prints only the verdict;
  //   why_new=HARN-1 (HARN-12) lanes of ~780 s were always PREGATE: incomplete under preflight; seam=gstack-pregate timeout_s; no_claim=the finish fallback, which runs the same pregate default
  test('timeout_s from the base policy bounds Step 5 pregate and PREGATE_DETAIL names it', () => {
    const slow = "const test = require('node:test');\ntest('slow', async () => { await new Promise(r => setTimeout(r, 4000)); });\n";
    const f = fx(base({ timeout_s: 2 }), { 'test/slow.serial.test.js': slow });
    const r = f.run(PREFLIGHT, ['--tests-only', '--base', 'main', '--lane', LANE]);
    expect(r.status).toBe(3);
    expect(lineOf(r.stdout, 'PREGATE')).toMatch(/^PREGATE: (tests |all )?incomplete/);
    expect(lineOf(r.stdout, 'PREGATE_DETAIL')).toContain('timed out after 2000 ms (timeout_s from origin/main');
  });
});
