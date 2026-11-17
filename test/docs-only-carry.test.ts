/**
 * R81 docs-only carry (lib/run-evidence.ts verifyRun, lib/ci-carry.ts findCarry; docs/pregate.md#docs-only): a pull
 * request run whose docs-scope gate skipped every suite on a docs-only change carries as not owed, and only when this
 * checkout's classifier agrees. The same run never stands as a tested tree. Fakes only; nothing reaches GitHub.
 */
import { expect, test } from 'bun:test';
import { findCarry } from '../lib/ci-carry';
import type { ApiJob, ApiRun, RunDeps, RunProfile, RunSource } from '../lib/run-evidence';
import { verifyRun } from '../lib/run-evidence';

const REPO = 'garrytan/gstack';
const HEAD = 'a'.repeat(40);
const TREE = 'b'.repeat(40);
const NOW = new Date('2026-11-08T12:00:00Z');
const SUITES = ['free-plan', 'typecheck'];
const PROFILE: RunProfile = { workflow: 'free-tests.yml', events: ['pull_request', 'workflow_dispatch'], jobs: [...SUITES, 'free-tests'], artifact: 'tested-tree', os: 'Linux', skippable: { jobs: SUITES, gate: 'docs-scope', scripts: ['lib/docs-only.ts'] } };
const RUN: ApiRun = { id: 7, run_attempt: 1, status: 'completed', conclusion: 'success', event: 'pull_request', head_sha: HEAD, path: '.github/workflows/free-tests.yml', created_at: '2026-11-08T11:00:00Z', updated_at: '2026-11-08T11:10:00Z', repository: { full_name: REPO }, head_repository: { full_name: REPO } } as ApiRun;
const job = (name: string, conclusion: string): ApiJob => ({ name, conclusion, completed_at: '2026-11-08T11:10:00Z' }) as ApiJob;
const JOBS = [job('docs-scope', 'success'), ...SUITES.map(n => job(n, 'skipped')), job('free-tests', 'success')];
let artifactReads = 0;
const deps: RunDeps = {
  run: () => RUN,
  runsForHead: (_wf, sha) => (sha === HEAD ? [RUN] : []),
  jobs: () => JOBS,
  artifact: () => { artifactReads++; throw new Error('no artifact'); },
  commitTree: sha => (sha === HEAD ? TREE : null),
};
const source = (docsOnly?: (h: string) => boolean): RunSource => ({ repo: REPO, deps, profiles: { 'ci-reuse/free-tests': PROFILE }, now: NOW, unchanged: () => null, ...(docsOnly ? { docsOnly } : {}) });
const carry = (src: RunSource) => findCarry(src, { profiles: ['ci-reuse/free-tests'], head: HEAD, tree: TREE, wtree: () => TREE, inventory: () => ['test/a.test.ts'] });

test('a docs-only pull request run carries as not owed without reading a tested tree', () => {
  artifactReads = 0;
  const v = carry(source(h => h === HEAD));
  expect(v.ok).toBe(true);
  if (!v.ok) return;
  expect(v.notOwed).toContain('docs-only change');
  expect(v.tests).toBe('n/a');
  expect(v.receipt).toMatch(/^ci-carry tree=bbbbbbbbbbbb not_owed=docs-only runs=7\/1 /);
  expect(artifactReads).toBe(0);
});

test('the same skipped run does not carry when this checkout calls the change code (a reused run, or a moved base)', () => {
  const v = carry(source(() => false));
  expect(v.ok).toBe(false);
  if (!v.ok) expect(v.detail).toContain('artifact_missing');
});

test('without a classifier (ci-tree-reuse find), a docs-only run is never a tested tree, so a push to main cannot reuse it', () => {
  const v = verifyRun(deps, { repo: REPO, runRef: '7', profileName: 'ci-reuse/free-tests', profile: PROFILE, now: NOW, unchanged: () => null });
  expect(v.ok ? 'ok' : v.reason).toBe('artifact_missing');
});

test('a run whose gate job failed never counts its skipped suites', () => {
  const failed: RunDeps = { ...deps, jobs: () => [job('docs-scope', 'failure'), ...SUITES.map(n => job(n, 'skipped')), job('free-tests', 'success')] };
  const v = verifyRun(failed, { repo: REPO, runRef: '7', profileName: 'ci-reuse/free-tests', profile: PROFILE, now: NOW, unchanged: () => null, docsOnly: () => true });
  expect(v.ok ? 'ok' : v.reason).toBe('job_skipped');
});

// Value: protects=a docs-only skipped run at a commit with HEAD's tree (GST-3019) carries as not owed only when HEAD itself is docs-only;
//   fails_when=the ancestor's classification exempts a HEAD whose base merge changed runtime code against the new base; why_new=GST-3019 review; seam=RunDeps.ancestors
test('a docs-only run at a same-tree ancestor carries only when HEAD is docs-only too', () => {
  const TWIN = 'c'.repeat(40);
  const atTwin: ApiRun = { ...RUN, head_sha: TWIN };
  const twinDeps: RunDeps = { ...deps, run: () => atTwin, runsForHead: (_wf, sha) => (sha === TWIN ? [atTwin] : []), commitTree: sha => (sha === HEAD || sha === TWIN ? TREE : null), ancestors: sha => [sha, TWIN] };
  const at = (docsOnly: (h: string) => boolean) => carry({ ...source(docsOnly), deps: twinDeps });
  const ancestorOnly = at(h => h === TWIN);
  expect(ancestorOnly.ok).toBe(false);
  if (!ancestorOnly.ok) expect(ancestorOnly.detail).toContain('artifact_missing');
  const both = at(() => true);
  expect(both.ok && both.notOwed).toContain('docs-only change');
});
