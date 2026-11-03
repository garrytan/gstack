/**
 * scripts/ci-tree-reuse.ts (GSTA-156 P3b): the main-push consumer's candidate discovery and the aggregate's tree.json
 * producer. The GitHub API is a fake (ReuseDeps), so every refusal has a fixture and nothing here reaches GitHub.
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { bunIsolationArgs } from '../lib/bun-isolation';
import type { ApiJob, ApiRun, RunProfile, TreeRecord } from '../lib/run-evidence';
import { MAX_CANDIDATES, findReuse, reuseOutputs, treeRecord, type ApiPull, type ReuseDeps } from '../scripts/ci-tree-reuse';

const REPO = 'garrytan/gstack';
const PUSH = '1'.repeat(40);
const HEAD = '2'.repeat(40);
const MERGE = '3'.repeat(40);
const TREE = '4'.repeat(40);
const NOW = new Date('2026-10-30T12:00:00Z');
const PROFILE: RunProfile = { workflow: 'free-tests.yml', events: ['pull_request', 'workflow_dispatch'], jobs: ['free-plan', 'free-tests'], artifact: 'tested-tree', os: 'Linux' };
const SCRIPT = path.resolve(import.meta.dir, '..', 'scripts', 'ci-tree-reuse.ts');

interface Fake { id: number; event?: string; conclusion?: string | null; status?: string; started?: string; head?: string; record?: Partial<TreeRecord> | Error; jobs?: ApiJob[] }
interface World { pulls: ApiPull[] | Error; runs: Fake[]; trees: Record<string, string | null> }
const pull = (over: Partial<ApiPull> = {}): ApiPull => ({ number: 42, merged_at: '2026-10-30T11:00:00Z', merge_commit_sha: PUSH, base: { ref: 'main', repo: { full_name: REPO } }, head: { sha: HEAD, repo: { full_name: REPO } }, ...over });
function world(over: Partial<World> = {}): World {
  return { pulls: [pull()], runs: [{ id: 100 }], trees: { [PUSH]: TREE, [HEAD]: TREE, [MERGE]: TREE }, ...over };
}
function deps(w: World, reads: number[] = []): ReuseDeps {
  const api = (f: Fake): ApiRun => ({
    id: f.id, run_attempt: 1, status: f.status ?? 'completed', conclusion: f.conclusion === undefined ? 'success' : f.conclusion, event: f.event ?? 'workflow_dispatch', head_sha: f.head ?? HEAD,
    path: '.github/workflows/free-tests.yml', created_at: f.started ?? '2026-10-30T10:00:00Z', run_started_at: f.started ?? '2026-10-30T10:00:00Z', updated_at: '2026-10-30T10:30:00Z',
    repository: { full_name: REPO }, head_repository: { full_name: REPO },
  });
  const byId = (id: number) => { const f = w.runs.find(r => r.id === id); if (!f) throw new Error('HTTP 404'); return f; };
  return {
    pullsForCommit: () => { if (w.pulls instanceof Error) throw w.pulls; return w.pulls; },
    run: id => { reads.push(id); return api(byId(id)); },
    runsForHead: (wf, sha) => (wf === 'free-tests.yml' ? w.runs.filter(r => (r.head ?? HEAD) === sha).map(api) : []),
    jobs: id => byId(id).jobs ?? [{ name: 'free-plan', conclusion: 'success' }, { name: 'free-tests', conclusion: 'success' }],
    artifact: id => {
      const f = byId(id);
      if (f.record instanceof Error) throw f.record;
      const pr = (f.event ?? 'workflow_dispatch') === 'pull_request';
      return { run_id: id, run_attempt: 1, event: f.event ?? 'workflow_dispatch', sha: pr ? MERGE : f.head ?? HEAD, head_sha: f.head ?? HEAD, tree: TREE, os: ['Linux', 'macOS', 'Windows'], files: ['test/a.test.ts'], tests: 9, ...f.record };
    },
    commitTree: sha => w.trees[sha] ?? null,
  };
}
const find = (w: World, reads?: number[]) => findReuse(deps(w, reads), { repo: REPO, base: 'main', pushSha: PUSH, workflow: 'free-tests.yml', profileName: 'ci-reuse/free-tests', profile: PROFILE, now: NOW });
const why = (w: World) => { const v = find(w); return v.reused ? 'reused' : v.reason; };

describe('findReuse: candidate discovery for a main push', () => {
  test('the merged pull request\'s green dispatch run of the pushed tree is reused', () => {
    expect(find(world())).toEqual({ reused: true, run_id: 100, run_attempt: 1, event: 'workflow_dispatch', pr: 42, head_sha: HEAD, tree: TREE });
  });

  test('a green pull_request run counts when its merge commit tested the head tree, and not when the head was behind main', () => {
    expect(find(world({ runs: [{ id: 100, event: 'pull_request' }] }))).toMatchObject({ reused: true, run_id: 100, event: 'pull_request' });
    const behind = find(world({ runs: [{ id: 100, event: 'pull_request' }], trees: { [PUSH]: TREE, [HEAD]: TREE, [MERGE]: '5'.repeat(40) } }));
    expect(behind).toMatchObject({ reused: false, reason: 'no_verified_run', detail: expect.stringContaining('reason=tree_mismatch') });
  });

  test('no pull request, an unmerged one, one merged elsewhere, another merge commit, or two candidates: no reuse', () => {
    expect(why(world({ pulls: [] }))).toBe('no_pr');
    expect(why(world({ pulls: [pull({ merged_at: null })] }))).toBe('no_pr');
    expect(why(world({ pulls: [pull({ base: { ref: 'release', repo: { full_name: REPO } } })] }))).toBe('no_pr');
    expect(why(world({ pulls: [pull({ merge_commit_sha: MERGE })] }))).toBe('no_pr');
    expect(why(world({ pulls: [pull(), pull({ number: 43 })] }))).toBe('ambiguous_pr');
  });

  test('a fork head is never reused', () => {
    expect(why(world({ pulls: [pull({ head: { sha: HEAD, repo: { full_name: 'someone/gstack' } } })] }))).toBe('fork_head');
    expect(why(world({ pulls: [pull({ head: { sha: HEAD, repo: null } })] }))).toBe('fork_head');
  });

  test('a pull request head whose tree is not the pushed tree is refused before any run is read', () => {
    const reads: number[] = [];
    expect(find(world({ trees: { [PUSH]: TREE, [HEAD]: '6'.repeat(40) } }), reads)).toMatchObject({ reused: false, reason: 'tree_mismatch' });
    expect(reads).toEqual([]);
  });

  test('a reuse record is never evidence: a run that itself reused another run is refused', () => {
    expect(find(world({ runs: [{ id: 100, record: { reused: true } }] }))).toMatchObject({ reused: false, reason: 'no_verified_run', detail: expect.stringContaining('reason=artifact_reused') });
    expect(find(world({ runs: [{ id: 100, record: new Error('no artifact named tested-tree') }] }))).toMatchObject({ reused: false, detail: expect.stringContaining('reason=artifact_missing') });
  });

  test('a newer red run on the head vetoes an older green one', () => {
    const v = find(world({ runs: [{ id: 100, started: '2026-10-30T10:00:00Z' }, { id: 101, conclusion: 'failure', started: '2026-10-30T10:40:00Z' }] }));
    expect(v).toMatchObject({ reused: false, reason: 'no_verified_run' });
    expect(!v.reused && v.detail).toContain('run 101 (workflow_dispatch) reason=run_not_success');
    expect(!v.reused && v.detail).toContain('run 100 (workflow_dispatch) reason=newer_run_vetoes');
    expect(why(world({ runs: [{ id: 100, started: '2026-10-30T10:00:00Z' }, { id: 101, status: 'in_progress', conclusion: null, started: '2026-10-30T10:40:00Z' }] }))).toBe('no_verified_run');
  });

  test('push runs are never candidates, and a red candidate with no older green one is refused', () => {
    expect(why(world({ runs: [{ id: 100, event: 'push' }] }))).toBe('no_candidate');
    expect(why(world({ runs: [{ id: 100, conclusion: 'cancelled' }] }))).toBe('no_verified_run');
    expect(why(world({ runs: [{ id: 100, jobs: [{ name: 'free-plan', conclusion: 'success' }, { name: 'free-tests', conclusion: 'skipped' }] }] }))).toBe('no_verified_run');
  });

  test('candidates are bounded: at most MAX_CANDIDATES runs are verified, newest first', () => {
    const runs: Fake[] = Array.from({ length: MAX_CANDIDATES + 5 }, (_, i) => ({ id: 200 + i, conclusion: 'failure', started: `2026-10-30T10:${String(10 + i).padStart(2, '0')}:00Z` }));
    const reads: number[] = [];
    expect(find(world({ runs }), reads)).toMatchObject({ reused: false, reason: 'no_verified_run' });
    expect(new Set(reads).size).toBe(MAX_CANDIDATES);
    expect(reads[0]).toBe(200 + MAX_CANDIDATES + 4);
  });

  test('an API failure is a refusal, never a pass', () => {
    expect(why(world({ pulls: new Error('HTTP 403') }))).toBe('api_error');
    expect(why(world({ trees: { [HEAD]: TREE } }))).toBe('api_error');
  });

  test('outputs: reused=true is written last with the run link; a refusal writes reused=false and its reason', () => {
    const ok = reuseOutputs({ reused: true, run_id: 100, run_attempt: 2, event: 'pull_request', pr: 42, head_sha: HEAD, tree: TREE }, REPO);
    expect(ok.output).toBe(`run_id=100\nrun_url=https://github.com/${REPO}/actions/runs/100\ntree=${TREE}\nreused=true\n`);
    expect(ok.line).toStartWith('REUSE: accepted run 100 (pull_request, attempt 2) of #42');
    expect(reuseOutputs({ reused: false, reason: 'no_pr', detail: 'x' }, REPO)).toEqual({ line: 'REUSE: refused reason=no_pr — x; every job runs', output: 'reused=false\nreason=no_pr\n' });
  });
});

describe('treeRecord: the tested-tree producer', () => {
  const plan = { shards: [{ files: ['test/b.test.ts', 'test/a.test.ts'] }, { files: ['test/c.test.ts'] }] };
  const results = [{ outcome: { summary: { testsRan: 7 } } }, { outcome: { summary: { testsRan: 5 } } }];
  const env = (over: Record<string, string> = {}) => ({ GITHUB_RUN_ID: '300', GITHUB_RUN_ATTEMPT: '2', GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_SHA: HEAD, GITHUB_WORKFLOW_REF: `${REPO}/.github/workflows/free-tests.yml@refs/heads/x`, ...over });
  test('a dispatch or push run records its own commit as the head; a pull_request run records the PR head beside the merge commit', () => {
    expect(treeRecord(env(), { plan, results, os: ['Linux', 'macOS', 'Windows'], tree: TREE })).toEqual({ run_id: 300, run_attempt: 2, event: 'workflow_dispatch', sha: HEAD, head_sha: HEAD, tree: TREE, workflow: '.github/workflows/free-tests.yml', os: ['Linux', 'macOS', 'Windows'], files: ['test/a.test.ts', 'test/b.test.ts', 'test/c.test.ts'], tests: 12 });
    expect(treeRecord(env({ GITHUB_EVENT_NAME: 'pull_request', GITHUB_SHA: MERGE, PR_HEAD_SHA: HEAD }), { plan, results, os: ['Windows'], tree: TREE })).toMatchObject({ event: 'pull_request', sha: MERGE, head_sha: HEAD });
    expect(treeRecord(env(), { plan, results: [{ outcome: {} }], os: ['Linux'], tree: TREE }).tests).toBe(3);
  });
  test('missing or malformed inputs throw, so the aggregate fails instead of uploading a record', () => {
    expect(() => treeRecord(env({ GITHUB_EVENT_NAME: 'pull_request', GITHUB_SHA: MERGE }), { plan, results, os: ['Linux'], tree: TREE })).toThrow(/PR_HEAD_SHA/);
    expect(() => treeRecord(env({ GITHUB_RUN_ID: '' }), { plan, results, os: ['Linux'], tree: TREE })).toThrow(/GITHUB_RUN_ID/);
    expect(() => treeRecord(env({ GITHUB_WORKFLOW_REF: 'x' }), { plan, results, os: ['Linux'], tree: TREE })).toThrow(/GITHUB_WORKFLOW_REF/);
    expect(() => treeRecord(env(), { plan, results, os: ['BeOS'], tree: TREE })).toThrow(/--os/);
    expect(() => treeRecord(env(), { plan, results, os: ['Linux'], tree: '' })).toThrow(/tree id/);
    expect(() => treeRecord(env(), { plan: { shards: [] }, results, os: ['Linux'], tree: TREE })).toThrow(/no test files/);
  });
});

describe.skipIf(process.platform === 'win32')('the CLI', () => {
  const run = (args: string[], env: Record<string, string>, cwd: string) => spawnSync(process.execPath, [...bunIsolationArgs(), SCRIPT, ...args], { cwd, env: { PATH: process.env.PATH ?? '', HOME: cwd, ...env }, encoding: 'utf8', timeout: 30_000 });

  test('find consumes only on a push to main: pull_request and dispatch runs write reused=false without reading anything', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-reuse-'));
    try {
      for (const [event, ref] of [['pull_request', 'refs/pull/1/merge'], ['workflow_dispatch', 'refs/heads/main'], ['push', 'refs/heads/feature']]) {
        const out = path.join(dir, 'out');
        fs.writeFileSync(out, '');
        const r = run(['find', '--workflow', 'free-tests.yml', '--profile', 'ci-reuse/free-tests'], { GITHUB_EVENT_NAME: event!, GITHUB_REF: ref!, GITHUB_REPOSITORY: REPO, GITHUB_SHA: PUSH, GITHUB_OUTPUT: out, PATH: '/nonexistent' }, dir);
        expect([event, r.status]).toEqual([event, 0]);
        expect(fs.readFileSync(out, 'utf8')).toBe('reused=false\nreason=not_main_push\n');
      }
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test('record writes tree.json from the checkout\'s own tree and the plan', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-reuse-'));
    try {
      fs.writeFileSync(path.join(dir, '.gitconfig-fixture'), '[user]\n\tname = t\n\temail = t@test\n[commit]\n\tgpgsign = false\n');
      const git = (...a: string[]) => spawnSync('git', a, { cwd: dir, encoding: 'utf8', timeout: 30_000, env: { ...process.env, GIT_CONFIG_GLOBAL: path.join(dir, '.gitconfig-fixture'), GIT_CONFIG_NOSYSTEM: '1' } }).stdout.trim();
      git('init', '-q');
      fs.writeFileSync(path.join(dir, 'f'), 'x\n');
      git('add', 'f', '.gitconfig-fixture');
      git('commit', '-qm', 'c');
      const sha = git('rev-parse', 'HEAD');
      fs.writeFileSync(path.join(dir, 'plan.json'), JSON.stringify({ shards: [{ files: ['test/a.test.ts'] }] }));
      fs.mkdirSync(path.join(dir, 'results'));
      fs.writeFileSync(path.join(dir, 'results', 'shard-1.json'), JSON.stringify({ outcome: { summary: { testsRan: 4 } } }));
      const r = run(['record', '--plan', 'plan.json', '--results', 'results', '--os', 'Linux', '--out', 'tt/tree.json'], { GITHUB_RUN_ID: '9', GITHUB_RUN_ATTEMPT: '1', GITHUB_EVENT_NAME: 'push', GITHUB_SHA: sha, GITHUB_WORKFLOW_REF: `${REPO}/.github/workflows/free-tests.yml@refs/heads/main` }, dir);
      expect([r.status, r.stderr]).toEqual([0, '']);
      expect(JSON.parse(fs.readFileSync(path.join(dir, 'tt', 'tree.json'), 'utf8'))).toMatchObject({ run_id: 9, event: 'push', sha, head_sha: sha, tree: git('rev-parse', 'HEAD^{tree}'), files: ['test/a.test.ts'], tests: 4, os: ['Linux'] });
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
