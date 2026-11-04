/**
 * gstack-pregate --stage tests --from-run <run> (GSTA-156 P3b): the selected local test files a verified Free Tests
 * run on this exact tree lists count as passed and are recorded with its receipt; the rest still run. A refused run
 * prints its REUSE: refused line and runs everything. The run API is a fake; trees come from the fixture repository.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as path from 'node:path';
import { EXIT, type PregateFile } from '../lib/headless-artifacts';
import { buildContext } from '../lib/pregate/context';
import { readPregateFile, runPregate, writePregateFile } from '../lib/pregate/index';
import type { ApiRun, RunProfile, RunSource } from '../lib/run-evidence';
import { cleanup, commit, makeFixtureRepo, runBin, type FixtureRepo } from './helpers/pregate-fixture';

const NOW = new Date('2026-10-30T12:00:00Z');
const LOCAL_OS = process.platform === 'darwin' ? 'macOS' : 'Linux';
const PROFILE: RunProfile = { workflow: 'free-tests.yml', events: ['pull_request', 'workflow_dispatch'], jobs: ['unit'], artifact: 'tested-tree', os: LOCAL_OS };
const repos: FixtureRepo[] = [];
const savedRoot = process.env.GSTACK_STATE_ROOT;
afterEach(() => {
  while (repos.length) cleanup(repos.pop()!);
  if (savedRoot === undefined) delete process.env.GSTACK_STATE_ROOT; else process.env.GSTACK_STATE_ROOT = savedRoot;
});

function fixture(): { repo: FixtureRepo; parent: string; head: string } {
  const repo = makeFixtureRepo();
  repos.push(repo);
  process.env.GSTACK_STATE_ROOT = repo.home;
  const parent = repo.git('rev-parse', 'HEAD');
  commit(repo, { 'lib/util.js': 'exports.add = (a, b) => a + b + 0;\n', 'lib/retry.js': 'exports.MAX_RETRIES = 3;\nexports.TIMEOUT_MS = 5000;\nexports.retry = (fn) => fn();\nexports.touched = true;\n' }, 'touch two subjects');
  return { repo, parent, head: repo.git('rev-parse', 'HEAD') };
}

function source(repo: FixtureRepo, runHead: string, files: string[], profiles: Record<string, RunProfile> = { 'ci-reuse/free-tests': PROFILE }): RunSource {
  const api: ApiRun = { id: 100, run_attempt: 1, status: 'completed', conclusion: 'success', event: 'workflow_dispatch', head_sha: runHead, path: '.github/workflows/free-tests.yml', created_at: '2026-10-30T10:00:00Z', updated_at: '2026-10-30T10:30:00Z', repository: { full_name: 'fx/fx' }, head_repository: { full_name: 'fx/fx' } };
  return {
    repo: 'fx/fx', profiles, now: NOW,
    deps: {
      run: () => api, runsForHead: (_wf, sha) => (sha === runHead ? [api] : []), jobs: () => [{ name: 'unit', conclusion: 'success' }],
      artifact: () => ({ run_id: 100, run_attempt: 1, event: 'workflow_dispatch', sha: runHead, head_sha: runHead, tree: repo.git('rev-parse', `${runHead}^{tree}`), os: [LOCAL_OS], files, tests: files.length * 4 }),
      commitTree: sha => repo.git('rev-parse', `${sha}^{tree}`),
    },
  };
}

async function lanes(repo: FixtureRepo, fromRun?: { ref: string; check: RunSource | { error: string } }) {
  const progress: string[] = [];
  const loaded = buildContext({ repoRoot: repo.work, base: 'main', policyFrom: 'base', allowRepoCommands: true, env: { ...process.env, ...repo.env }, progress: l => progress.push(l), cores: 16, testBackend: 'local' });
  if (!('ctx' in loaded)) throw new Error('fixture context refused');
  if (fromRun) loaded.ctx.fromRun = fromRun;
  const file = await runPregate(loaded.ctx, { stage: 'tests' });
  return { file, check: file.checks.find(c => c.id === 'lanes')!, progress };
}
const ranLine = (c: PregateFile['checks'][number]) => (c.lines ?? []).find(l => l.startsWith('ran: ')) ?? '';

describe.skipIf(process.platform === 'win32')('--from-run: a verified Free Tests run covers part of the tests stage', () => {
  test('without --from-run every selected file runs (the baseline)', async () => {
    const { repo } = fixture();
    const { check } = await lanes(repo);
    expect(check.status).toBe('pass');
    expect(ranLine(check)).toContain('test/util.test.js');
    expect(ranLine(check)).toContain('test/retry.test.js');
    expect(check.from_run).toBeUndefined();
  }, 120_000);

  test('the files the run lists count as passed and are recorded with its receipt; the rest still run, and pregate.json validates', async () => {
    const { repo, head } = fixture();
    const { file, check, progress } = await lanes(repo, { ref: '100', check: source(repo, head, ['test/util.test.js', 'test/unrelated.test.js']) });
    expect(check.status).toBe('pass');
    expect(check.from_run).toEqual({ receipt: expect.stringMatching(new RegExp(`^run tree=${file.tree.slice(0, 12)} tests=8 runs=100/1 profiles=ci-reuse/free-tests heads=${head.slice(0, 12)} verified=`)), files: ['test/util.test.js'] });
    expect(ranLine(check)).toContain('test/retry.test.js');
    expect(ranLine(check)).not.toContain('test/util.test.js');
    expect(check.detail).toStartWith('1 of 3 local test file(s) passed in the --from-run run; ');
    expect(progress).toContain(`REUSE: accepted 1 of 3 selected local test file(s) from ${check.from_run!.receipt}; 2 still run`);
    const out = path.join(repo.work, '.gstack', 'tmp', 'pregate.json');
    writePregateFile(repo.work, out, file);
    expect(readPregateFile(out).file?.checks.find(c => c.id === 'lanes')?.from_run?.files).toEqual(['test/util.test.js']);
  }, 120_000);

  test('a run covering every selected file leaves nothing to run', async () => {
    const { repo, head } = fixture();
    const all = ['test/nightly/retry-heavy.test.js', 'test/retry.test.js', 'test/util.test.js'];
    const { check } = await lanes(repo, { ref: '100', check: source(repo, head, all) });
    expect([check.status, check.from_run?.files.sort(), ranLine(check)]).toEqual(['pass', all, '']);
  }, 120_000);

  test('a refused run prints its REUSE line and runs everything: another tree, no profile for a local lane or this OS, unreadable profiles', async () => {
    const { repo, parent, head } = fixture();
    const cases: Array<[string, RunSource | { error: string }]> = [
      ['tree_mismatch', source(repo, parent, ['test/util.test.js', 'test/retry.test.js'])],
      ['no_profile', source(repo, head, ['test/util.test.js'], { 'ci-reuse/windows': { ...PROFILE, workflow: 'windows.yml', os: 'Windows' } })],
      ['no_profile', source(repo, head, ['test/util.test.js'], { 'ci-reuse/free-tests': { ...PROFILE, os: 'Windows' } })],
      ['no_profile', source(repo, head, ['test/util.test.js'], { 'free-tests.yml/unit': { ...PROFILE, workflow: 'other.yml' } })],
      ['profiles_unavailable', { error: 'origin is not a github.com repository' }],
    ];
    for (const [reason, check] of cases) {
      const r = await lanes(repo, { ref: '100', check });
      expect([reason, r.progress.find(l => l.startsWith('REUSE: '))]).toEqual([reason, expect.stringMatching(new RegExp(`^REUSE: refused reason=${reason} — .*; every selected test runs here$`))]);
      expect([reason, r.check.from_run, ranLine(r.check).includes('test/util.test.js') && ranLine(r.check).includes('test/retry.test.js')]).toEqual([reason, undefined, true]);
    }
  }, 240_000);

  test('the CLI: --from-run is a tests-stage flag, and without a GitHub origin it refuses and runs everything', () => {
    const { repo } = fixture();
    const preflight = runBin(repo, 'gstack-pregate', ['--stage', 'preflight', '--from-run', '100']);
    expect([preflight.status, preflight.err]).toEqual([EXIT.usage, expect.stringContaining('--from-run applies to the tests stage')]);
    const tests = runBin(repo, 'gstack-pregate', ['--stage', 'tests', '--from-run', '100', '--allow-repo-commands']);
    expect(tests.err).toContain('REUSE: refused reason=profiles_unavailable — origin is not a github.com repository');
    expect(tests.status).toBe(EXIT.ok);
  }, 120_000);
});
