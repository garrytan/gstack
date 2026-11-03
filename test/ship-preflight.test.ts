/**
 * gstack-ship-preflight (GSTA-167 PR 4): /ship Steps 1-3 and Step 5's pregate and lanes in
 * one command. These are the checks Steps 1-3 and 5 used to spell out as shell blocks,
 * moved into the bin; each STOP is a place the prose leaves the decision to the agent.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { laneConcurrency } from '../lib/ship-bin-common';
import { lineOf, PREFLIGHT, RELEASE, shipFixture, type ShipFx } from './helpers/ship-bin-fixture';

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

  // Value: protects=a failed lookup of the remote's HEAD stops with "restore access first" instead of guessing the default branch from a local origin/HEAD;
  //   fails_when=a failed ls-remote falls back to the local ref, so the default branch with no local origin/HEAD merges another base and goes on, and a feature
  //   branch a Capy checkout's origin/HEAD names is refused as the base branch; why_new=GST-511 follow-up from #3718; seam=a git wrapper on PATH that fails
  //   ls-remote only; no_claim=which access failure it was
  test('a failed remote HEAD lookup stops before merging, even when the fetch works', () => {
    const f = fx();
    fs.writeFileSync(path.join(f.root, 'stub', 'git'), `#!/bin/sh\n[ "$1" = ls-remote ] && { echo "ls-remote: unreachable" >&2; exit 128; }\nexec ${Bun.which('git')} "$@"\n`, { mode: 0o755 });
    f.git('push', '-q', 'origin', 'main:release');
    f.git('checkout', '-q', 'main');
    f.git('remote', 'set-head', 'origin', '-d');
    const onDefault = f.run(PREFLIGHT, ['--base', 'release']);
    f.git('checkout', '-q', 'feat');
    f.git('update-ref', 'refs/remotes/origin/feat', 'HEAD');
    f.git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/feat');
    const onFeature = f.run(PREFLIGHT, ['--base', 'main']);
    for (const r of [onDefault, onFeature]) {
      expect(r.status).toBe(3);
      expect(r.stdout).toContain('STOP: git ls-remote origin HEAD failed: ls-remote: unreachable; restore access first');
      expect(r.stdout).not.toContain('MERGE:');
    }
  });

  // Value: protects=a remote whose HEAD names no branch (detached, or a server that sends no symref) falls back to the default-base ladder, not the local origin/HEAD;
  //   fails_when=the fallback reads the local ref, so the default branch with no local origin/HEAD merges another base and goes on, and a feature branch a
  //   Capy checkout's origin/HEAD names is refused as the base branch; why_new=pass-1 review of the ls-remote stop; seam=a git wrapper whose ls-remote prints
  //   only a sha; no_claim=a repository whose default is neither main nor master
  test('with no symbolic remote HEAD, the default branch still stops and a feature branch named by a local origin/HEAD goes on', () => {
    const f = fx();
    fs.writeFileSync(path.join(f.root, 'stub', 'git'), `#!/bin/sh\n[ "$1" = ls-remote ] && { echo "0000000000000000000000000000000000000000\tHEAD"; exit 0; }\nexec ${Bun.which('git')} "$@"\n`, { mode: 0o755 });
    f.git('push', '-q', 'origin', 'main:release');
    f.git('checkout', '-q', 'main');
    f.git('remote', 'set-head', 'origin', '-d');
    const onDefault = f.run(PREFLIGHT, ['--base', 'release']);
    expect(onDefault.status).toBe(3);
    expect(onDefault.stdout).toContain('STOP: on the base branch (main)');
    expect(onDefault.stdout).not.toContain('MERGE:');
    f.git('checkout', '-q', 'feat');
    f.git('update-ref', 'refs/remotes/origin/feat', 'HEAD');
    f.git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/feat');
    const onFeature = f.run(PREFLIGHT, ['--base', 'main']);
    expect(onFeature.stdout).not.toContain('STOP: on the base branch');
    expect(onFeature.status).toBe(0);
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

  // Value: protects=Step 1 refreshes origin/<base> itself, so a clone whose fetch refspec leaves out the base (a single-branch
  //   clone) still diffs against the current base tip (GST-462, HARN-15); fails_when=preflight runs `git fetch origin <base>`,
  //   which then updates only FETCH_HEAD; seam=remote.origin.fetch; no_claim=remotes other than origin
  test('a single-branch clone: the fetch refreshes origin/<base>, so DIFF is the branch alone', () => {
    const f = fx({ '.gstack/ship-policy.json': '{"queue_mode":"stamp-at-merge"}\n' });
    f.git('config', 'remote.origin.fetch', '+refs/heads/feat:refs/remotes/origin/feat');
    f.advanceBase({ 'docs/new.md': '# new\n' });
    f.git('fetch', '-q', f.origin, 'main');
    f.git('merge', '-q', '--no-edit', 'FETCH_HEAD');
    const stale = f.git('rev-parse', 'origin/main').stdout.trim();
    const r = f.run(PREFLIGHT, ['--base', 'main']);
    expect(r.status).toBe(0);
    expect(f.git('rev-parse', 'origin/main').stdout.trim()).not.toBe(stale);
    expect(lineOf(r.stdout, 'DIFF')).toMatch(/^DIFF: 1 file changed, 1 insertion\(\+\); commits=2$/);
  });

  // Value: protects=a diff far larger than the PR's own (a stale or wrong base: HARN-15 reviewed 17,000 files of main's history)
  //   stops before any reader runs, naming the PR's base; fails_when=preflight never compares the diff with the PR's changed
  //   files; seam=gh pr view (changedFiles, headRefOid, baseRefName); no_claim=GitHub's own count
  test('a diff far beyond or short of the PR\'s changed files stops at the pushed head; another head or a matching size goes on', () => {
    const files = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`src/f${i}.ts`, `export const f${i} = ${i};\n`]));
    const f = fx({}, files);
    const head = f.git('rev-parse', 'HEAD').stdout.trim();
    const stub = (changed: number, prHead: string, prBase = 'release') => f.gh(`case "$*" in *"pr list"*) echo 7 ;; *changedFiles*) echo "${changed} ${prHead} ${prBase}" ;; esac`);
    stub(3, head);
    const r = f.run(PREFLIGHT, ['--base', 'main']);
    expect(r.status).toBe(3);
    expect(r.stdout).toContain('STOP: the diff against origin/main lists 60 files but PR #7 changes 3 (its base is release): origin/main is not the PR\'s base; rerun with --base release after git fetch origin +refs/heads/release:refs/remotes/origin/release');
    stub(3, head, 'main');
    const fork = f.run(PREFLIGHT, ['--base', 'main']);
    expect(fork.stdout).toContain('(its base is main): origin is not the PR\'s base repository (a fork) or its main has moved');
    expect(fork.stdout).not.toContain('rerun with --base');
    stub(3, head, 'x;rm');
    expect(f.run(PREFLIGHT, ['--base', 'main']).stdout).toContain("rerun with --base 'x;rm' after git fetch origin +refs/heads/'x;rm':refs/remotes/origin/'x;rm'");
    stub(61, head, 'main');
    const fewer = f.run(PREFLIGHT, ['--base', 'main']);
    expect(fewer.status).toBe(3);
    expect(fewer.stdout).toContain('STOP: the diff against origin/main lists 60 files but PR #7 changes 61 (its base is main): origin is not the PR\'s base repository (a fork) or its main has moved');
    for (const [changed, prHead] of [[3, 'f'.repeat(40)], [61, 'f'.repeat(40)], [60, head], [0, head]] as const) {
      stub(changed, prHead);
      const go = f.run(PREFLIGHT, ['--base', 'main']);
      expect(go.stdout).not.toContain('lists 60 files');
      expect(lineOf(go.stdout, 'PR')).toBe('PR: #7');
    }
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

  // Value: protects=Step 5 can run its lanes one at a time, and each lane keeps its own tests_ran (GST-851: GSTA-2 saw six lanes start within
  //   60 ms on a 4-core machine on gstack-evals#115); fails_when=--lanes serial lanes overlap, a lane loses its count, or a bad --lanes value runs;
  //   why_new=runLanes started every lane at once with no serial mode; seam=runLanes; no_claim=how long a lane takes
  test('--lanes serial runs one lane at a time and keeps each lane\'s count; a bad --lanes value is usage', () => {
    const f = fx();
    const log = path.join(f.root, 'lane-order.log');
    const lane = (n: string) => `${n}=echo start ${n} >> '${log}'; sleep 1; echo end ${n} >> '${log}'; printf " 2 pass\\n 0 fail\\nRan 2 tests across 1 file. [5.00ms]\\n"`;
    const r = f.run(PREFLIGHT, ['--tests-only', '--base', 'main', '--lanes', 'serial', '--lane', lane('a'), '--lane', lane('b')]);
    expect(r.status).toBe(0);
    const order = fs.readFileSync(log, 'utf8').trim().split('\n');
    expect(order.length).toBe(4);
    expect(order.map(l => l.split(' ')[0])).toEqual(['start', 'end', 'start', 'end']);
    expect(order[1]!.split(' ')[1]).toBe(order[0]!.split(' ')[1]);
    expect(r.stdout.split('\n').filter(l => l.startsWith('LANE: ')).map(l => l.replace(/ log=\S+$/, ''))).toEqual(['LANE: a pass exit=0 tests_ran=2', 'LANE: b pass exit=0 tests_ran=2']);
    expect(lineOf(r.stdout, 'LANES')).toBe('LANES: serial (--lanes)');
    expect(f.run(PREFLIGHT, ['--tests-only', '--base', 'main', '--lanes', 'fast', '--lane', LANE]).status).toBe(2);
    expect(f.run(PREFLIGHT, ['--tests-only', '--base', 'main', '--lane', LANE, '--lanes']).status).toBe(2);
  });

  // Value: protects=parallel lanes report in the order given even when a later lane finishes first, and an unflagged run names the core count
  //   behind its default (GST-851); fails_when=results come back in finish order or the LANES line drops its reason; why_new=runLanes became a
  //   worker pool; seam=runLanes, LANES line; no_claim=which default any given machine picks
  test('--lanes parallel keeps lane order when a later lane finishes first; unflagged LANES names the core count', () => {
    const f = fx();
    const lane = (n: string, wait: number) => `${n}=sleep ${wait}; printf " 1 pass\\n 0 fail\\nRan 1 tests across 1 file. [5.00ms]\\n"`;
    const r = f.run(PREFLIGHT, ['--tests-only', '--base', 'main', '--lanes', 'parallel', '--lane', lane('slow', 1), '--lane', lane('fast', 0)]);
    expect(r.status).toBe(0);
    expect(lineOf(r.stdout, 'LANES')).toBe('LANES: parallel (--lanes)');
    expect(r.stdout.split('\n').filter(l => l.startsWith('LANE: ')).map(l => l.split(' ')[1])).toEqual(['slow', 'fast']);
    expect(lineOf(f.run(PREFLIGHT, ['--tests-only', '--base', 'main', '--lane', LANE]).stdout, 'LANES')).toMatch(/^LANES: (serial|parallel) \(\d+ cores\)$/);
  });

  // Value: protects=a small machine runs lanes one at a time without a flag, a large one keeps running them together, and the flag overrides
  //   either way (GST-851); fails_when=a 4-core default runs lanes at once or the flag is ignored; why_new=no default existed; seam=laneConcurrency;
  //   no_claim=the core count of any CI runner
  test('lane concurrency: serial on 4 cores or fewer, parallel above, --lanes overrides', () => {
    expect([laneConcurrency(undefined, 2), laneConcurrency(undefined, 4), laneConcurrency(undefined, 8)]).toEqual([1, 1, Infinity]);
    expect([laneConcurrency('serial', 64), laneConcurrency('parallel', 2)]).toEqual([1, Infinity]);
    expect(laneConcurrency('fast', 8)).toBe('--lanes fast is not serial or parallel');
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

  // Value: protects=--timeout on preflight reaches Step 5's pregate, so a repo with no timeout_s can run lanes past 600 s without a standalone pregate; fails_when=preflight drops the flag and pregate runs at timeout_s or the 600 s default;
  //   why_new=GST-1196 (GEVA-2, gstack-evals#176/#179): a 128-file group stopped at 600 s; seam=gstack-pregate --timeout; no_claim=the finish fallback
  test('--timeout reaches Step 5 pregate over the policy and default, and a bad value is usage', () => {
    const slow = "const test = require('node:test');\ntest('slow', async () => { await new Promise(r => setTimeout(r, 4000)); });\n";
    const f = fx(base({ timeout_s: 600 }), { 'test/slow.serial.test.js': slow });
    const r = f.run(PREFLIGHT, ['--tests-only', '--base', 'main', '--timeout', '2', '--lane', LANE]);
    expect(r.status).toBe(3);
    expect(lineOf(r.stdout, 'PREGATE')).toMatch(/^PREGATE: (tests |all )?incomplete/);
    expect(lineOf(r.stdout, 'PREGATE_DETAIL')).toContain('timed out after 2000 ms (--timeout applies');
    for (const bad of ['0', '3601', '1.5', 'x']) {
      const u = f.run(PREFLIGHT, ['--tests-only', '--base', 'main', '--timeout', bad, '--lane', LANE]);
      expect(u.status).toBe(2);
      expect(u.stdout + u.stderr).toContain('--timeout needs whole seconds from 1 to 3600');
    }
  });
});

describe('gstack-ship-preflight during an open /ship run (GST-1204)', () => {
  const CHECKOUT = { GSTACK_LEASE_DIR: '' };
  const leaseFile = (f: ShipFx) => path.join(f.work, '.git', 'gstack-leases', String(process.pid));
  const wtree = (f: ShipFx) => f.run(path.join(path.dirname(RELEASE), 'gstack-wtree'), [], CHECKOUT).stdout.trim();
  /** Steps 12-16 in the fixture: the version bump, the docs snapshot and finish (the step that ends the run's hold on the base merge). */
  const finish = (f: ShipFx) => {
    const reviewed = wtree(f);
    expect(f.run(RELEASE, ['version', '--base', 'main', '--bump', 'micro'], CHECKOUT).status).toBe(0);
    const post = path.join(f.root, 'post.json');
    expect(f.run(path.join(path.dirname(RELEASE), 'gstack-docs-candidate'), ['snapshot', '--out', post, '--audit-id', 'a1', '--mode', 'edit', '--base', 'main', '--docs', 'README.md'], CHECKOUT).status).toBe(0);
    const done = f.run(RELEASE, ['finish', '--base', 'main', '--reviewed-tree', reviewed, '--docs-post', post, '--lane', LANE], CHECKOUT);
    expect(done.status, done.stdout).toBe(0);
  };
  const refusedUntouched = (f: ShipFx, args: string[], run: string, added = 'docs/new.md') => {
    const head = f.git('rev-parse', 'HEAD').stdout.trim();
    const tracked = f.git('rev-parse', 'origin/main').stdout.trim();
    const r = f.run(PREFLIGHT, args, CHECKOUT);
    expect(r.status).toBe(3);
    expect(r.stdout).toContain(`STOP: /ship run ${run} is open on this checkout and past its preflight (`);
    expect(r.stdout).toContain('rerun Step 5 with --tests-only');
    expect(r.stdout).toMatch(/if it is no longer running, rm \S+gstack-ship-run, then rerun/);
    expect(r.stdout).not.toContain('MERGE:');
    expect(f.git('rev-parse', 'HEAD').stdout.trim()).toBe(head);
    expect(f.git('rev-parse', 'origin/main').stdout.trim()).toBe(tracked);
    expect(f.git('status', '--porcelain').stdout).toBe('');
    expect(fs.existsSync(path.join(f.work, added))).toBe(false);
  };

  // Value: protects=a full preflight run again while this checkout's /ship run is open and past its own preflight stops before the fetch, so review readers never diff a tree the base merge moved;
  //   fails_when=the rerun fetches or merges origin/<base> into the tree readers are diffing (gbrain-evals#317 voided a review pass), with or without --run; why_new=GST-1204;
  //   seam=the run marker and gstack-lease open on the checkout's own lease; no_claim=a preflight that never passed --run
  test('a full preflight while this checkout\'s /ship run is open and past its preflight refuses before the fetch and leaves the tree untouched', () => {
    const f = fx();
    const run = `${process.pid}-${Math.floor(Date.now() / 1000)}-ab12cd34`;
    expect(f.run(PREFLIGHT, ['--base', 'main', '--run', run], CHECKOUT).status).toBe(0);
    f.advanceBase({ 'docs/new.md': '# new\n' });
    refusedUntouched(f, ['--base', 'main', '--run', run], run);
    refusedUntouched(f, ['--base', 'main'], run);
  });

  // Value: protects=the Capy driver's sequence (ship/DRIVER.md Phase 2: preflight with --run and lanes, then --audit; repairs rerun --tests-only) is covered, and a mid-run full preflight is refused;
  //   fails_when=the guard needs a workflow lease the driver never takes (GBEV-3 was a Capy lane), or it blocks --audit or --tests-only; why_new=GST-1204 driver coverage;
  //   seam=the checkout lease gstack-ship-preflight opens itself; no_claim=reader dispatch
  test('the driver\'s sequence: Phase 2 preflight with --run, --audit and --tests-only go on; a mid-run full preflight is refused', () => {
    const f = fx();
    const phase2 = f.run(PREFLIGHT, ['--base', 'main', '--run', 'ship-run-7', '--lane', LANE], CHECKOUT);
    expect(phase2.status).toBe(0);
    expect(lineOf(phase2.stdout, 'LANE')).toMatch(/^LANE: tests pass/);
    expect(f.run(PREFLIGHT, ['--audit', '--base', 'main', '--out', path.join(f.root, 'run')], CHECKOUT).status).toBe(0);
    f.advanceBase({ 'docs/new.md': '# new\n' });
    refusedUntouched(f, ['--base', 'main', '--lane', LANE], 'ship-run-7');
    refusedUntouched(f, ['--base', 'main', '--run', 'ship-run-7', '--lane', LANE], 'ship-run-7');
    const repair = f.run(PREFLIGHT, ['--tests-only', '--base', 'main', '--lane', LANE], CHECKOUT);
    expect(repair.status).toBe(0);
    expect(lineOf(repair.stdout, 'LANE')).toMatch(/^LANE: tests pass exit=0 tests_ran=3/);
  });

  // Value: protects=finish ends the run's hold, and a run past the 120-minute window (GST-1205's fresh rule) no longer blocks the next preflight;
  //   fails_when=a marker left by an earlier /ship refuses every later preflight on the checkout; why_new=GST-1204 negative control; seam=finish clears the marker, gstack-lease fresh; no_claim=dead or reused holders, covered in test/gstack-lease.test.ts
  test('a finished or aged-out /ship run does not block a full preflight', () => {
    const ends: Record<string, (f: ShipFx) => void> = {
      finished: finish,
      'aged out': f => fs.writeFileSync(leaseFile(f), fs.readFileSync(leaseFile(f), 'utf8').replace(/^(run \S+ )(\d+)$/m, (_, p, t) => `${p}${Number(t) - 7300}`)),
    };
    for (const [why, end] of Object.entries(ends)) {
      const f = fx();
      expect(f.run(PREFLIGHT, ['--base', 'main', '--run', 'ship-run-7'], CHECKOUT).status).toBe(0);
      end(f);
      f.advanceBase({ 'docs/new.md': '# new\n' });
      const r = f.run(PREFLIGHT, ['--base', 'main'], CHECKOUT);
      expect({ why, status: r.status }).toEqual({ why, status: 0 });
      expect(lineOf(r.stdout, 'MERGE')).toMatch(/^MERGE: merged origin\/main at /);
    }
  });

  // Value: protects=a /ship that stopped before finish does not block the next /ship from the same harness: gstack-skill-end's real release closes only the install lease, so the
  //   new run id replaces the open one; another live holder's open run (another session) is still refused; fails_when=a stopped run blocks its own harness for 120 minutes
  //   (#3950 review), or any new id passes another session's open run; why_new=GST-1204 review fix 1; seam=gstack-lease open --from (the caller's harness); no_claim=Capy, where every session shares capy-server
  test('a stopped /ship (skill-end released it) does not block a new run id from the same holder; another live holder\'s run is still refused', () => {
    const f = fx();
    const stopped = `${process.pid}-${Math.floor(Date.now() / 1000)}-ab12cd34`;
    expect(f.run(PREFLIGHT, ['--base', 'main', '--run', stopped], CHECKOUT).status).toBe(0);
    const end = f.run(path.join(path.dirname(PREFLIGHT), 'gstack-skill-end'), ['--skill', 'ship', '--outcome', 'error', '--session-id', stopped, '--tel-start', '0'], { GSTACK_LEASE_DIR: path.join(f.root, 'install-leases') });
    expect(end.status, end.stdout + end.stderr).toBe(0);
    f.advanceBase({ 'docs/new.md': '# new\n' });
    refusedUntouched(f, ['--base', 'main', '--run', stopped], stopped);
    const next = f.run(PREFLIGHT, ['--base', 'main', '--run', 'ship-run-8'], CHECKOUT);
    expect(next.status, next.stdout).toBe(0);
    expect(lineOf(next.stdout, 'MERGE')).toMatch(/^MERGE: merged origin\/main at /);
    const other = spawn('sleep', ['300'], { stdio: 'ignore' });
    try {
      const touch = spawnSync('bash', [path.join(path.dirname(PREFLIGHT), 'gstack-lease'), 'touch', '--root', f.work, '--pid', String(other.pid), '--run', 'other-session'], { encoding: 'utf8', env: { ...process.env, ...CHECKOUT }, timeout: 30_000 });
      expect(touch.status).toBe(0);
      fs.writeFileSync(path.join(f.work, '.git', 'gstack-ship-run'), 'other-session\n');
      f.advanceBase({ 'docs/other.md': '# other\n' });
      refusedUntouched(f, ['--base', 'main', '--run', 'ship-run-9'], 'other-session', 'docs/other.md');
    } finally { other.kill('SIGKILL'); }
  });

  // Value: protects=a --run that cannot be recorded on the lease (a live process holds its lock) stops before the fetch instead of going on unprotected; fails_when=preflight exits 0
  //   with no record, so a later full preflight merges the base under the run's reviews (#3950 outside voice); why_new=GST-1204 review fix 2; seam=gstack-lease touch exit 3; no_claim=which process holds the lock
  test('a --run the lease cannot record stops before the fetch', () => {
    const f = fx();
    const lock = path.join(f.work, '.git', 'gstack-leases', '.lock');
    fs.mkdirSync(lock, { recursive: true });
    fs.writeFileSync(path.join(lock, 'owner'), `${process.pid} \n`);
    f.advanceBase({ 'docs/new.md': '# new\n' });
    const tracked = f.git('rev-parse', 'origin/main').stdout.trim();
    const r = f.run(PREFLIGHT, ['--base', 'main', '--run', 'ship-run-7'], { ...CHECKOUT, GSTACK_LEASE_LOCK_TRIES: '2' });
    expect(r.status).toBe(3);
    expect(r.stdout).toContain('STOP: cannot record /ship run ship-run-7 on this checkout\'s lease (gstack-lease: the lease directory is locked by live process');
    expect(r.stdout).not.toContain('MERGE:');
    expect(f.git('rev-parse', 'origin/main').stdout.trim()).toBe(tracked);
    expect(fs.existsSync(path.join(f.work, '.git', 'gstack-ship-run'))).toBe(false);
  });

  // Value: protects=/ship's own first preflight runs, and a first preflight that stopped (Step 3's conflict: commit and rerun) reruns in the same /ship run;
  //   fails_when=the run is recorded before Steps 1-3 pass, so /ship blocks itself; why_new=GST-1204 negative control; seam=the marker is written only once Steps 1-3 pass; no_claim=conflict resolution
  test('/ship\'s own first preflight runs, and a stopped first preflight reruns in the same run', () => {
    const f = fx({}, { 'src/a.ts': 'export const a = 2;\n' });
    f.advanceBase({ 'src/a.ts': 'export const a = 3;\n' });
    const first = f.run(PREFLIGHT, ['--base', 'main', '--run', 'ship-run-7'], CHECKOUT);
    expect(first.status).toBe(3);
    expect(first.stdout).toContain('STOP: merge conflicts in src/a.ts');
    f.write({ 'src/a.ts': 'export const a = 4;\n' });
    f.commit('merge main');
    const again = f.run(PREFLIGHT, ['--base', 'main', '--run', 'ship-run-7'], CHECKOUT);
    expect(again.status).toBe(0);
    expect(lineOf(again.stdout, 'MERGE')).toBe('MERGE: up to date');
  });

  // Value: protects=--run takes only a plain token, so a crafted value cannot become a path or split a lease entry; fails_when=any string is recorded and looked up;
  //   why_new=GST-1204; seam=flag parsing; no_claim=none
  test('--run that is not a plain run id is usage', () => {
    const f = fx();
    for (const bad of [['--run', '../x'], ['--run', 'a b'], ['--run', '-x'], ['--run']]) {
      const r = f.run(PREFLIGHT, ['--base', 'main', ...bad]);
      expect(r.status).toBe(2);
      expect(r.stderr).toContain('--run needs a run id');
    }
  });
});
