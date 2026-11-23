/**
 * GST-3567 (harness-evals #576): under direct landing, a pull_request run tests GitHub's merge of the head onto the base as
 * it was when the run started. When main moved past the head's fork point, that merge's tree is not the head's tree, so
 * accept refused CI_CARRY tree_mismatch and the lane had to merge main and run CI again, which never converges on a busy
 * repo. A green run still counts for the head when the merge commit is the head merged onto a base commit and the pull
 * request's own added and removed lines in it are byte-identical to the head's, at the same places: only the base moved. Land checks the tree that
 * lands (land.merged_ci), and its verify never takes this rule.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { onlyBaseMoved } from '../lib/pregate/run-check';
import { verifyRun, type ApiRun, type RunDeps, type RunProfile, type TreeRecord } from '../lib/run-evidence';
import { fakeGhScript, type FakeWorld } from './helpers/fake-gh-runs';
import { lineOf, RELEASE, shipFixture, type ShipFx } from './helpers/ship-bin-fixture';

setDefaultTimeout(120_000);
const BIN = path.dirname(RELEASE);
const fixtures: ShipFx[] = [];
afterEach(() => { while (fixtures.length) fixtures.pop()!.cleanup(); });

const FREE = "printf x >> ../free-runs; printf ' 3 pass\\n 0 fail\\nRan 3 tests across 1 file. [1.00ms]\\n' >&2";
const PROFILE: RunProfile = { workflow: 'free.yml', events: ['pull_request', 'workflow_dispatch'], jobs: ['suite'], artifact: 'tested-tree', os: 'Linux' };
const BASE = {
  '.gstack/pregate.json': JSON.stringify({ run_profiles: { 'ci/free': PROFILE }, ship_lanes_from: { [FREE]: { profiles: ['ci/free'], inventory: "printf 'test/a.test.ts\\ntest/b.test.ts\\n'" } } }, null, 2) + '\n',
  '.github/workflows/free.yml': 'name: Free\non: [pull_request, workflow_dispatch]\njobs:\n  suite:\n    runs-on: ubuntu-latest\n    steps:\n      - run: bun test\n',
  'src/b.ts': 'export const b = 1;\n// two\n// three\n// four\n// five\n// six\n// seven\n// eight\n',
};
const FEAT = { 'src/b.ts': 'export const b = 2;\n// two\n// three\n// four\n// five\n// six\n// seven\n// eight\n' };
/** main's edit to the pull request's own file: far from its line 1 (#4722's shape: both edited docs/troubleshooting.md), or right next to it. */
const FAR = { 'src/b.ts': 'export const b = 1;\n// two\n// three\n// four\n// five\n// six\n// seven\n// eight, edited on main\n' };
const NEXT_TO = { 'src/b.ts': 'export const b = 1;\n// two, edited on main\n// three\n// four\n// five\n// six\n// seven\n// eight\n' };
const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
const sha = (f: ShipFx, ref: string) => f.git('rev-parse', ref).stdout.trim();
const runs = (f: ShipFx) => { const p = path.join(f.root, 'free-runs'); return fs.existsSync(p) ? fs.readFileSync(p, 'utf8').length : 0; };

/** feat pushed at HEAD, then main moves under it with `baseFiles` (src/c.ts by default), as it did under #576. */
function behind(baseFiles: Record<string, string> = { 'src/c.ts': 'export const c = 3;\n' }): ShipFx {
  const f = shipFixture(BASE, FEAT);
  fixtures.push(f);
  expect(f.run(RELEASE, ['push', '--branch', 'feat', '--early', '--base', 'main'], { GSTACK_SESSION_KIND: 'unattended' }).status).toBe(0);
  f.advanceBase(baseFiles);
  expect(f.git('fetch', '-q', 'origin', 'main').status).toBe(0);
  return f;
}

/** GitHub's test merge commit for a pull_request run: the base first, the head second (#576's 2c6b624d: parents 0f7b4003, 2a5e69c4). */
function mergeCommit(f: ShipFx, head = sha(f, 'HEAD'), o: { tree?: string } = {}): { merge: string; tree: string } {
  const tree = o.tree ?? f.git('merge-tree', '--write-tree', 'origin/main', head).stdout.trim().split('\n')[0]!;
  const merge = f.git('commit-tree', tree, '-p', 'origin/main', '-p', head, '-m', `Merge ${head} into ${sha(f, 'origin/main').slice(0, 8)}`).stdout.trim();
  return { merge, tree };
}

/** One green pull_request run of free.yml at HEAD (id 7) whose tree.json records the merge it tested, as #576's run 45058890128 did. */
function prRun(f: ShipFx, m: { merge: string; tree: string }, over: { run?: Record<string, unknown> } = {}): void {
  const head = sha(f, 'HEAD');
  const run = { id: 7, run_attempt: 1, status: 'completed', conclusion: 'success', event: 'pull_request', head_sha: head, head_branch: 'feat', path: '.github/workflows/free.yml', created_at: at(20), run_started_at: at(20), updated_at: at(5), repository: { full_name: 'fx/fx' }, head_repository: { full_name: 'fx/fx' }, ...over.run };
  const w: FakeWorld = {
    runs: [run] as FakeWorld['runs'],
    jobs: { 7: [{ name: 'suite', conclusion: over.run?.conclusion === 'failure' ? 'failure' : 'success', completed_at: at(5) }] },
    trees: { 7: { run_id: 7, run_attempt: 1, event: 'pull_request', sha: m.merge, head_sha: head, tree: m.tree, files: ['test/a.test.ts', 'test/b.test.ts'], tests: 12, os: 'Linux' } },
  };
  fs.writeFileSync(path.join(f.root, 'world.json'), JSON.stringify(w));
  f.gh(fakeGhScript(path.join(f.root, 'world.json')));
}
const accept = (f: ShipFx) => f.run(RELEASE, ['accept', '--base', 'main', '--lane', `free=${FREE}`, '--wait', '0']);
const lane = (out: string) => out.split('\n').find(l => l.startsWith('LANE: free ')) ?? '';

describe('accept carries a run whose base moved when the pull request\'s own changes are byte-identical (GST-3567)', () => {
  // Value: protects=#576's shape carries: a green pull_request run at the pushed head that tested the head merged onto a newer main, with the
  //   pull request's own diff byte-identical, carries the lane and the final pregate without a local run or a fresh CI run;
  //   fails_when=accept refuses tree_mismatch and the lane merges main and reruns CI forever; seam=fake gh, real git merge commit
  test('the #576 shape: accept carries the lane and the final pregate from the run, and nothing runs here', () => {
    const f = behind();
    const m = mergeCommit(f);
    expect(m.tree).not.toBe(sha(f, 'HEAD^{tree}'));
    prRun(f, m);
    const ok = accept(f);
    expect([ok.status, lane(ok.stdout)], ok.stdout + ok.stderr).toEqual([0, 'LANE: free carried run=7/1 tests_ran=2 (files)']);
    expect(lineOf(ok.stdout, 'EVIDENCE')).toMatch(/^EVIDENCE: FRESH label=free .* source=ci runs=7\/1$/);
    expect(lineOf(ok.stdout, 'CI_CARRY')).toMatch(new RegExp(`^CI_CARRY: accepted ci-carry tree=${sha(f, 'HEAD^{tree}').slice(0, 12)} .*runs=7/1 .* base_moved=${sha(f, 'origin/main').slice(0, 12)} `));
    expect(ok.stdout).toMatch(/^PREGATE: (pass|warn)\b.* \(final tree\)$/m);
    expect(runs(f)).toBe(0);
    const found = f.run(path.join(BIN, 'gstack-ci-carry'), ['find', '--base', 'main']);
    expect([found.status, found.stdout]).toEqual([0, expect.stringMatching(/^CI_CARRY: accepted ci-carry tree=.* base_moved=/)]);
  });

  // Value: protects=main editing another part of a file the pull request also changes still carries: the pull request's own lines are
  //   byte-identical at the same places (#4722's run 45089670503: main and the PR both edited docs/troubleshooting.md); fails_when=the
  //   rule compares whole files and refuses; seam=fake gh, real git merge commit
  test('main edited another part of the pull request\'s own file: the run still carries', () => {
    const f = behind(FAR);
    prRun(f, mergeCommit(f));
    const found = f.run(path.join(BIN, 'gstack-ci-carry'), ['find', '--base', 'main']);
    expect([found.status, found.stdout]).toEqual([0, expect.stringMatching(/^CI_CARRY: accepted ci-carry tree=.* base_moved=/)]);
  });

  // Value: protects=the negative controls: a merge whose pull-request side differs from the head (a conflict resolution, another head),
  //   a base that also edited the pull request's own file, and a red run never carry; fails_when=any of them carries; seam=fake gh, real git
  test('the pull request\'s own lines differ: an edited merge, or main editing the line next to the pull request\'s, refuses tree_mismatch', () => {
    const f = behind();
    const clean = mergeCommit(f);
    f.git('read-tree', clean.tree);
    const blob = spawnSync('git', ['hash-object', '-w', '--stdin'], { cwd: f.work, input: 'export const b = 99;\n', encoding: 'utf8', timeout: 30_000 }).stdout.trim();
    f.git('update-index', '--cacheinfo', `100644,${blob},src/b.ts`);
    const edited = f.git('write-tree').stdout.trim();
    f.git('read-tree', 'HEAD');
    prRun(f, mergeCommit(f, sha(f, 'HEAD'), { tree: edited }));
    const out = f.run(path.join(BIN, 'gstack-ci-carry'), ['find', '--base', 'main']).stdout;
    expect(out).toContain("tree_mismatch (the pull request's base moved after the run; fix: gh workflow run free.yml --ref feat, then gstack-ci-carry wait))");
    expect(out).toContain("CARRY_DIAGNOSIS: run 7 tested a merge onto a newer base, but it does not count for the head: the pull request's own added and removed lines in the tested merge are not byte-identical to the head's at the same places (the base edited a line the pull request changes, or one next to it), so more than the base moved (docs/pregate.md#base-moved-carry)");
    expect(out).not.toContain('CI_CARRY: accepted');

    const g = behind(NEXT_TO);
    const both = mergeCommit(g);
    expect(both.tree).toMatch(/^[0-9a-f]{40}$/);
    prRun(g, both);
    const refused = accept(g);
    expect(refused.status).not.toBe(0);
    expect(refused.stdout).toContain('CI_CARRY: none label=free (no_verified_run: ci/free: run 7: tree_mismatch');
    expect(refused.stdout).toContain("CARRY_DIAGNOSIS: run 7 tested a merge onto a newer base, but it does not count for the head: the pull request's own added and removed lines in the tested merge are not byte-identical");
    expect(runs(g)).toBe(0);
  });

  test('the run tested another head: a merge of an earlier commit of the branch refuses tree_mismatch', () => {
    const f = behind();
    const earlier = sha(f, 'HEAD');
    f.write({ 'src/d.ts': 'export const d = 4;\n' });
    f.commit('second feat commit');
    expect(f.run(RELEASE, ['push', '--branch', 'feat', '--early', '--base', 'main'], { GSTACK_SESSION_KIND: 'unattended' }).status).toBe(0);
    prRun(f, mergeCommit(f, earlier));
    const out = f.run(path.join(BIN, 'gstack-ci-carry'), ['find', '--base', 'main']).stdout;
    expect(out).toContain('it does not count for the head: merge commit ');
    expect(out).toContain(' is not a base commit merged with the head ' + sha(f, 'HEAD').slice(0, 12) + ' (its parents: ');
    expect(out).not.toContain('CI_CARRY: accepted');
  });

  test('a red run never carries, whatever its merge', () => {
    const f = behind();
    prRun(f, mergeCommit(f), { run: { conclusion: 'failure' } });
    const red = accept(f);
    expect(red.status).not.toBe(0);
    expect(red.stdout).toContain('STOP: free.yml run 7 failed (suite)');
    expect(f.run(path.join(BIN, 'gstack-ci-carry'), ['find', '--base', 'main']).stdout).not.toContain('CI_CARRY: accepted');
  });
});

describe('only lane carries take the rule; land\'s merged-tree CI never does (GST-3567)', () => {
  /** In-process RunDeps over the fixture's git, serving the one pull_request run. */
  function deps(f: ShipFx, m: { merge: string; tree: string }): RunDeps {
    const head = sha(f, 'HEAD');
    const run: ApiRun = { id: 7, run_attempt: 1, status: 'completed', conclusion: 'success', event: 'pull_request', head_sha: head, head_branch: 'feat', path: '.github/workflows/free.yml', created_at: at(20), run_started_at: at(20), updated_at: at(5), repository: { full_name: 'fx/fx' }, head_repository: { full_name: 'fx/fx' } };
    const rec: TreeRecord = { run_id: 7, run_attempt: 1, event: 'pull_request', sha: m.merge, head_sha: head, tree: m.tree, files: ['test/a.test.ts'], tests: 3, os: 'Linux' };
    return {
      run: () => run, runsForHead: () => [run], jobs: () => [{ name: 'suite', conclusion: 'success', completed_at: at(5) }], artifact: () => rec,
      commitTree: s => { const r = f.git('rev-parse', '--verify', '--quiet', `${s}^{tree}`); return r.status === 0 ? r.stdout.trim() : null; },
    };
  }

  // Value: protects=item 3 of GST-3567: land.merged_ci's verify (lib/land-merged-ci.ts ghCiDeps) calls verifyRun with no onlyBaseMoved, so a
  //   run that tested an older merge can never stand in for CI on the tree that lands; fails_when=verifyRun takes the rule by default
  test('verifyRun refuses the base-moved run unless the caller passes onlyBaseMoved, and then counts it for the head tree', () => {
    const f = behind();
    const m = mergeCommit(f);
    const d = deps(f, m);
    const base = { repo: 'fx/fx', runRef: '7', profileName: 'ci/free', profile: PROFILE, now: new Date() };
    const land = verifyRun(d, base);
    expect(land.ok ? 'ok' : land.reason).toBe('tree_mismatch');
    const carry = verifyRun(d, { ...base, onlyBaseMoved: (merge, head) => onlyBaseMoved(f.work, { merge, head, baseRef: 'origin/main' }) });
    expect(carry.ok && carry.evidence).toEqual(expect.objectContaining({ tree: sha(f, 'HEAD^{tree}'), base_moved: { merge: m.merge, base: sha(f, 'origin/main'), tested_tree: m.tree } }));
  });

  test('onlyBaseMoved: a base parent that is not on the base branch refuses', () => {
    const f = behind();
    const stray = f.git('commit-tree', sha(f, 'origin/main^{tree}'), '-p', 'origin/main', '-m', 'not on main').stdout.trim();
    const tree = f.git('merge-tree', '--write-tree', stray, 'HEAD').stdout.trim().split('\n')[0]!;
    const merge = f.git('commit-tree', tree, '-p', stray, '-p', 'HEAD', '-m', 'merge').stdout.trim();
    const v = onlyBaseMoved(f.work, { merge, head: sha(f, 'HEAD'), baseRef: 'origin/main' });
    expect(v).toEqual({ ok: false, why: expect.stringContaining('is not on origin/main, even after fetching it') });
  });

  // Value: protects=GitHub merging onto a main newer than the checkout's origin/main still counts: onlyBaseMoved fetches the base once
  //   before refusing; fails_when=a stale origin/main refuses the carry and the lane reruns CI for nothing; seam=real git, local origin
  test('onlyBaseMoved: a base parent newer than the checkout\'s origin/main is fetched, then counts', () => {
    const f = behind();
    const stale = sha(f, 'origin/main');
    f.advanceBase({ 'src/e.ts': 'export const e = 5;\n' });
    expect(f.git('fetch', '-q', '--refmap=', 'origin', '+refs/heads/main:refs/ci-tested/main').status).toBe(0);
    const tested = sha(f, 'refs/ci-tested/main');
    const tree = f.git('merge-tree', '--write-tree', tested, 'HEAD').stdout.trim().split('\n')[0]!;
    const merge = f.git('commit-tree', tree, '-p', tested, '-p', 'HEAD', '-m', 'merge').stdout.trim();
    expect([sha(f, 'origin/main'), tested]).toEqual([stale, expect.not.stringMatching(stale)]);
    expect(onlyBaseMoved(f.work, { merge, head: sha(f, 'HEAD'), baseRef: 'origin/main' })).toEqual({ ok: true, base: tested });
    expect(sha(f, 'origin/main')).toBe(tested);
  });
});
