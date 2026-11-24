/**
 * land.merged_ci (lib/land-merged-ci.ts): the CI run land dispatches on the merged commit when the base moved. Fake
 * dependencies stand in for git push, gh and lib/run-evidence.ts, so each verdict and the scratch branch's cleanup are
 * checked without a network.
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { bunIsolationArgs } from '../lib/bun-isolation';
import { runMergedCi, type CiDeps } from '../lib/land-merged-ci';
import { landPolicyErrors } from '../lib/land-merged-checks';
import type { ApiRun } from '../lib/run-evidence';

const COMMIT = 'c'.repeat(40), TREE = 't'.repeat(40);
const CI = { workflow: 'free-tests.yml', profile: 'ci-reuse/free-tests' };
type Calls = string[];

function fake(o: { runs?: ApiRun[][]; verify?: ReturnType<CiDeps['verify']>; push?: string; dispatch?: string; earlier?: ApiRun[]; atCommit?: ApiRun[] } = {}): { deps: CiDeps; calls: Calls } {
  const calls: Calls = [];
  let clock = 0, polls = 0, sent = false;
  const runs = o.runs ?? [[{ id: 7, run_attempt: 1, status: 'completed', conclusion: 'success', event: 'workflow_dispatch', head_sha: COMMIT }]];
  const deps: CiDeps = {
    push: (c, b) => { calls.push(`push ${c.slice(0, 4)} ${b}`); return o.push ?? null; },
    remove: b => { calls.push(`remove ${b}`); },
    dispatch: (w, b) => { calls.push(`dispatch ${w} ${b}`); sent = true; return o.dispatch ?? null; },
    runsAt: () => (sent ? runs[Math.min(polls++, runs.length - 1)] ?? [] : o.atCommit ?? []),
    runsOn: (w, b) => { calls.push(`runsOn ${w} ${b}`); return o.earlier ?? []; },
    run: id => { const r = runs[Math.min(polls++, runs.length - 1)]?.[0]; return r ?? { id, run_attempt: 1, status: 'queued', conclusion: null, event: 'workflow_dispatch', head_sha: COMMIT }; },
    verify: () => o.verify ?? { ok: true, head: COMMIT, tree: TREE },
    sleep: ms => { clock += ms; },
    now: () => clock,
    url: id => `https://example.invalid/runs/${id}`,
  };
  return { deps, calls };
}
const run = (deps: CiDeps, timeoutMs?: number) => runMergedCi(deps, { pr: '42', commit: COMMIT, tree: TREE, ci: CI, timeoutMs });
const noLookup = (calls: Calls) => calls.filter(c => !c.startsWith('runsOn '));
const queued: ApiRun = { id: 7, run_attempt: 1, status: 'in_progress', conclusion: null, event: 'workflow_dispatch', head_sha: COMMIT };

describe('land.merged_ci', () => {
  test('a green run that verifies the merged commit and tree passes; land pushes gstack-land/<pr>, dispatches there, waits, and deletes the branch', () => {
    const { deps, calls } = fake({ runs: [[], [queued], [queued], [{ ...queued, status: 'completed', conclusion: 'success' }]] });
    const r = run(deps);
    expect(r).toEqual({ ok: true, line: 'MERGED_CI: pass free-tests.yml run https://example.invalid/runs/7 on the merged tree tttttttttttt (profile ci-reuse/free-tests)' });
    expect(noLookup(calls)).toEqual(['push cccc gstack-land/42', 'dispatch free-tests.yml gstack-land/42', 'remove gstack-land/42']);
  });

  test('a red run refuses as red, naming its conclusion, and the branch is still deleted', () => {
    const { deps, calls } = fake({ runs: [[{ ...queued, status: 'completed', conclusion: 'failure' }]] });
    const r = run(deps);
    expect(r).toMatchObject({ ok: false, red: true });
    expect(r.ok ? '' : r.detail).toContain('concluded failure');
    expect(calls.at(-1)).toBe('remove gstack-land/42');
  });

  test('a green run the run profile does not accept, or one that tested another commit, is no proof: refused, not red', () => {
    const refused = run(fake({ verify: { ok: false, detail: 'job_missing: free-tests' } }).deps);
    expect(refused).toMatchObject({ ok: false, red: false });
    expect(refused.ok ? '' : refused.detail).toContain('does not prove the tree under ci-reuse/free-tests: job_missing: free-tests');
    const other = run(fake({ verify: { ok: true, head: 'd'.repeat(40), tree: TREE } }).deps);
    expect(other).toMatchObject({ ok: false, red: false });
    expect(other.ok ? '' : other.detail).toContain('not the merged commit cccccccccccc');
  });

  test('no run by the timeout, a run still going at the timeout, a failed dispatch: refused, not red, and the branch is deleted; a failed push dispatches nothing', () => {
    const none = fake({ runs: [[]] });
    const r1 = run(none.deps, 60_000);
    expect(r1).toMatchObject({ ok: false, red: false });
    expect(r1.ok ? '' : r1.detail).toContain('no free-tests.yml run appeared on gstack-land/42');
    expect(none.calls.at(-1)).toBe('remove gstack-land/42');
    const slow = run(fake({ runs: [[queued]] }).deps, 60_000);
    expect(slow.ok ? '' : slow.detail).toContain('is still in_progress after');
    const sent = fake({ dispatch: 'HTTP 422' });
    expect(run(sent.deps)).toMatchObject({ ok: false, red: false, detail: 'gh workflow run free-tests.yml --ref gstack-land/42 failed: HTTP 422' });
    expect(sent.calls.at(-1)).toBe('remove gstack-land/42');
    const pushed = fake({ push: 'rejected' });
    expect(run(pushed.deps)).toMatchObject({ ok: false, red: false });
    expect(noLookup(pushed.calls)).toEqual(['push cccc gstack-land/42']);
  });

  test('the policy key: { workflow, profile } only, a workflow file name and a run profile name; it may stand without merged_checks', () => {
    expect(landPolicyErrors({ merged_ci: CI })).toEqual([]);
    expect(landPolicyErrors({ merged_checks: ['true'], merged_ci: CI })).toEqual([]);
    for (const bad of [{ workflow: '../x.yml', profile: 'p' }, { workflow: 'free-tests.yml' }, { ...CI, extra: 1 }, 'free-tests.yml', null]) expect(landPolicyErrors({ merged_ci: bad }).map(e => e.path)).toContain('land.merged_ci');
  });

  test('gstack\'s own base policy runs Free Tests on the merged tree under a run profile its pregate config declares', () => {
    const root = path.join(import.meta.dir, '..');
    const ci = JSON.parse(fs.readFileSync(path.join(root, '.gstack', 'ship-policy.json'), 'utf8')).land?.merged_ci;
    expect(ci).toEqual(CI);
    expect(JSON.parse(fs.readFileSync(path.join(root, '.gstack', 'pregate.json'), 'utf8')).run_profiles?.[ci.profile]?.workflow).toBe(ci.workflow);
  });
});

describe('land.merged_ci reuses an earlier run on the merged tree (GST-3634)', () => {
  const OLD = 'a'.repeat(40), OTHER = 'o'.repeat(40);
  const earlier = (over: Partial<ApiRun>): ApiRun => ({ id: 9, run_attempt: 1, status: 'completed', conclusion: 'success', event: 'workflow_dispatch', head_sha: OLD, head_branch: 'gstack-land/42', head_commit: { tree_id: TREE }, ...over });
  const provesOld = { ok: true as const, head: OLD, tree: TREE };

  test('a finished green run an earlier land dispatched on gstack-land/<pr>, at another commit with the merged tree, lands with no push and no new dispatch', () => {
    const green = earlier({});
    const { deps, calls } = fake({ earlier: [green], runs: [[green]], verify: provesOld });
    const r = run(deps);
    expect(r.ok).toBe(true);
    expect(r.ok ? r.line : '').toBe('MERGED_CI: pass free-tests.yml run https://example.invalid/runs/9 on the merged tree tttttttttttt (profile ci-reuse/free-tests; run by an earlier land at aaaaaaaaaaaa, not dispatched again)');
    expect(calls.some(c => c.startsWith('push ') || c.startsWith('dispatch '))).toBe(false);
    expect(calls).toContain('runsOn free-tests.yml gstack-land/42');
  });

  test('a run still in progress on the merged tree is adopted and waited on, not duplicated', () => {
    const going = earlier({ status: 'queued', conclusion: null });
    const { deps, calls } = fake({ earlier: [going], runs: [[going], [{ ...going, status: 'in_progress' }], [{ ...going, status: 'completed', conclusion: 'success' }]], verify: provesOld });
    expect(run(deps).ok).toBe(true);
    expect(calls.some(c => c.startsWith('push ') || c.startsWith('dispatch '))).toBe(false);
  });

  test('a red run on the merged tree refuses as red with no new dispatch, naming the run', () => {
    const red = earlier({ conclusion: 'failure' });
    const { deps, calls } = fake({ earlier: [red], runs: [[red]], verify: provesOld });
    const r = run(deps);
    expect(r).toMatchObject({ ok: false, red: true, run: 9 });
    expect(r.ok ? '' : r.detail).toContain('runs/9 on the merged tree tttttttttttt concluded failure');
    expect(calls.some(c => c.startsWith('dispatch '))).toBe(false);
  });

  test('the match is on the tree, never the commit: runs on other trees and cancelled runs are skipped, and the newest live run on the tree decides', () => {
    const otherTree = fake({ earlier: [earlier({ id: 11, head_commit: { tree_id: OTHER } })] });
    expect(run(otherTree.deps).ok).toBe(true);
    expect(otherTree.calls).toContain('dispatch free-tests.yml gstack-land/42');
    const cancelledOnly = fake({ earlier: [earlier({ conclusion: 'cancelled' })] });
    run(cancelledOnly.deps);
    expect(cancelledOnly.calls).toContain('dispatch free-tests.yml gstack-land/42');
    const sameCommitOtherTree = fake({ earlier: [earlier({ head_sha: COMMIT, head_commit: { tree_id: OTHER } })] });
    run(sameCommitOtherTree.deps);
    expect(sameCommitOtherTree.calls).toContain('dispatch free-tests.yml gstack-land/42');
    const green = earlier({ id: 45249277829 });
    const pr4753 = fake({ earlier: [earlier({ id: 45268196043, head_sha: 'b'.repeat(40), conclusion: 'cancelled' }), green], runs: [[green]], verify: provesOld });
    const r = run(pr4753.deps);
    expect(r.ok ? r.line : r.detail).toContain('runs/45249277829');
    expect(pr4753.calls.some(c => c.startsWith('dispatch '))).toBe(false);
  });

  test('a finished green run that no longer proves the tree (an expired artifact, past max age) is no reason to refuse: land dispatches a fresh run', () => {
    let verified = 0;
    const green = earlier({});
    const { deps, calls } = fake({ earlier: [green], runs: [[green], [], [queued], [{ ...queued, status: 'completed', conclusion: 'success' }]] });
    let post = 0;
    const runAt = deps.runsAt;
    deps.runsAt = (w, c) => { if (calls.some(x => x.startsWith('dispatch '))) post++; return runAt(w, c); };
    deps.verify = () => (verified++ === 0 ? { ok: false, detail: 'run_stale: finished 30 hours ago' } : { ok: true, head: COMMIT, tree: TREE });
    expect(run(deps).ok).toBe(true);
    expect(calls).toContain('dispatch free-tests.yml gstack-land/42');
    expect(post).toBe(2);
  });

  test('a run found at the merged commit itself counts, with no branch listing needed', () => {
    const green = earlier({ head_sha: COMMIT, head_branch: 'gstack-land/42' });
    const { deps, calls } = fake({ atCommit: [green], runs: [[green]] });
    expect(run(deps).ok).toBe(true);
    expect(calls.some(c => c.startsWith('push ') || c.startsWith('dispatch '))).toBe(false);
  });

  test('an adopted run that finishes green but cannot be proved refuses without dispatching', () => {
    const going = earlier({ status: 'in_progress', conclusion: null });
    const { deps, calls } = fake({ earlier: [going], runs: [[going], [{ ...going, status: 'completed', conclusion: 'success' }]], verify: { ok: false, detail: 'artifact_missing: tested-tree' } });
    const r = run(deps);
    expect(r).toMatchObject({ ok: false, red: false });
    expect(r.ok ? '' : r.detail).toContain('does not prove the tree');
    expect(calls.some(c => c.startsWith('push ') || c.startsWith('dispatch '))).toBe(false);
  });

  test('an adopted run that times out names that run and does not dispatch', () => {
    const going = earlier({ status: 'queued', conclusion: null });
    const { deps, calls } = fake({ earlier: [going], runs: [[going]], verify: provesOld });
    expect(run(deps, 60_000)).toMatchObject({ ok: false, red: false, run: 9 });
    expect(calls.some(c => c.startsWith('push ') || c.startsWith('dispatch '))).toBe(false);
    expect(calls.at(-1)).toBe('remove gstack-land/42');
  });

  test('a green run that is rerun between listing and polling decides on what land polled: red refuses as red and a timeout names it, never a fresh dispatch', () => {
    const listed = earlier({});
    const rerun = { ...listed, run_attempt: 2, status: 'in_progress', conclusion: null };
    const red = fake({ earlier: [listed], runs: [[rerun], [{ ...rerun, status: 'completed', conclusion: 'failure' }]], verify: provesOld });
    expect(run(red.deps)).toMatchObject({ ok: false, red: true, run: 9 });
    expect(red.calls.some(c => c.startsWith('push ') || c.startsWith('dispatch '))).toBe(false);
    const slow = fake({ earlier: [listed], runs: [[rerun]], verify: provesOld });
    expect(run(slow.deps, 60_000)).toMatchObject({ ok: false, red: false, run: 9 });
    expect(slow.calls.some(c => c.startsWith('push ') || c.startsWith('dispatch '))).toBe(false);
  });

  test('a timed-out wait names the run the next land adopts, and that land adopts it after the scratch branch was deleted', () => {
    const going: ApiRun = { ...queued, id: 77, head_branch: 'gstack-land/42', head_commit: { tree_id: TREE } };
    const first = fake({ runs: [[going]] });
    const r1 = run(first.deps, 60_000);
    expect(r1).toMatchObject({ ok: false, red: false, run: 77 });
    expect(r1.ok ? '' : r1.detail).toContain('runs/77 is still in_progress after');
    expect(r1.ok ? '' : r1.detail).toContain('the next land onto the same base waits on this run instead of dispatching another');
    expect(first.calls.at(-1)).toBe('remove gstack-land/42');
    const done = { ...going, status: 'completed', conclusion: 'success' };
    const second = fake({ earlier: [done], runs: [[done]] });
    const r2 = run(second.deps);
    expect(r2.ok ? r2.line : r2.detail).toContain('runs/77 on the merged tree tttttttttttt');
    expect(second.calls.some(c => c.startsWith('push ') || c.startsWith('dispatch '))).toBe(false);
  });
});

describe('queue git hooks', () => {
  test.skipIf(process.platform === 'win32')('a queue git call runs the checkout\'s hooks until land turns them off, so wave and train pushes keep the managed pre-push guard', () => {
    const gate = JSON.stringify(path.join(import.meta.dir, '..', 'crew', 'lib', 'ship-queue-gate.ts'));
    const script = `const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
      const { git, queueHooksOff } = await import(${gate});
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-hooks-'));
      const marker = path.join(dir, 'ran');
      const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
      git(dir, ['init', '-q'], env);
      fs.writeFileSync(path.join(dir, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\\necho x >> "' + marker + '"\\n', { mode: 0o755 });
      const runs = () => fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8').split('\\n').filter(Boolean).length : 0;
      const before = git(dir, ['commit', '-q', '--allow-empty', '-m', 'a'], env).ok && runs();
      queueHooksOff();
      const after = git(dir, ['commit', '-q', '--allow-empty', '-m', 'b'], env).ok && runs();
      fs.rmSync(dir, { recursive: true, force: true });
      console.log(JSON.stringify({ before, after }));`;
    const r = spawnSync(process.execPath, [...bunIsolationArgs(), '-e', script], { encoding: 'utf8', timeout: 60_000 });
    expect(r.stderr).toBe('');
    expect(JSON.parse(r.stdout)).toEqual({ before: 1, after: 1 });
  });
});
