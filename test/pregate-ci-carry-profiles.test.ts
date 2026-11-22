/**
 * GST-3381 (a): the CI carry (the tests stage's automatic --from-run) takes the newest verified run under every run
 * profile for this machine at HEAD's tree, not only the first, so a second green workflow at the same tree (an E2E run
 * beside the Test run) also shortens the local remainder. A profile whose run is red or tested another tree adds
 * nothing. The Actions API is a gh shim on PATH; trees come from the fixture repository.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { buildContext } from '../lib/pregate/context';
import { runPregate } from '../lib/pregate/index';
import type { RunProfile } from '../lib/run-evidence';
import { BASE_PREGATE, cleanup, commit, makeFixtureRepo, type FixtureRepo } from './helpers/pregate-fixture';

const repos: FixtureRepo[] = [];
const savedPath = process.env.PATH;
const savedRoot = process.env.GSTACK_STATE_ROOT;
afterEach(() => {
  while (repos.length) cleanup(repos.pop()!);
  process.env.PATH = savedPath;
  if (savedRoot === undefined) delete process.env.GSTACK_STATE_ROOT; else process.env.GSTACK_STATE_ROOT = savedRoot;
});

const LOCAL_OS = process.platform === 'darwin' ? 'macOS' : 'Linux';
const PROFILES: Record<string, RunProfile> = {
  'ci-reuse/free-tests': { workflow: 'free-tests.yml', events: ['workflow_dispatch'], jobs: ['unit'], artifact: 'tested-tree', os: LOCAL_OS },
  'ci-reuse/e2e': { workflow: 'e2e.yml', events: ['workflow_dispatch'], jobs: ['e2e'], artifact: 'e2e-tree', os: LOCAL_OS },
};
const E2E_WORKFLOW = 'name: E2E\non: [workflow_dispatch]\njobs:\n  e2e:\n    runs-on: ubuntu-24.04\n    steps:\n      - uses: actions/checkout@v4\n      - name: Run e2e tests\n        run: node --test test/*.test.js\n';

function fixture(): FixtureRepo {
  const repo = makeFixtureRepo({ pregate: { ...BASE_PREGATE, run_profiles: PROFILES }, baseFiles: { '.github/workflows/e2e.yml': E2E_WORKFLOW } });
  repos.push(repo);
  process.env.GSTACK_STATE_ROOT = repo.home;
  commit(repo, { 'lib/util.js': 'exports.add = (a, b) => a + b + 0;\n', 'lib/retry.js': 'exports.MAX_RETRIES = 3;\nexports.TIMEOUT_MS = 5000;\nexports.retry = (fn) => fn();\nexports.touched = true;\n' }, 'touch two subjects');
  repo.git('push', '-q', 'origin', 'feature');
  repo.git('remote', 'set-url', 'origin', 'https://github.com/fx/fx.git');
  repo.git('config', `url.${repo.origin}.insteadOf`, 'https://github.com/fx/fx.git');
  return repo;
}

interface Run { id: number; workflow: string; job: string; artifact: string; files: string[]; conclusion?: string; tree?: string }
/** A gh on PATH answering the Actions reads ghRunDeps makes, for `runs` at HEAD; `flip` moves run `run` to a red attempt 2 once run `after`'s tree.json has been downloaded `downloads` times. */
function ghShim(repo: FixtureRepo, runs: Run[], flip?: { run: number; after: number; downloads: number }): void {
  const head = repo.git('rev-parse', 'HEAD');
  const tree = repo.git('rev-parse', 'HEAD^{tree}');
  const at = new Date(Date.now() - 600_000).toISOString();
  const data = Object.fromEntries(runs.map(r => [r.id, {
    run: { id: r.id, run_attempt: 1, status: 'completed', conclusion: r.conclusion ?? 'success', event: 'workflow_dispatch', head_sha: head, path: `.github/workflows/${r.workflow}`, created_at: at, updated_at: at, repository: { full_name: 'fx/fx' }, head_repository: { full_name: 'fx/fx' } },
    jobs: [{ name: r.job, conclusion: r.conclusion ?? 'success', completed_at: at }],
    artifact: r.artifact,
    tree: { run_id: r.id, run_attempt: 1, event: 'workflow_dispatch', sha: head, tree: r.tree ?? tree, os: [LOCAL_OS], files: r.files, tests: r.files.length * 4 },
  }]));
  const dir = path.join(repo.root, 'gh-shim');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'data.json'), JSON.stringify({ runs: data, flip: flip ?? null, dir }));
  fs.writeFileSync(path.join(dir, 'gh'), [
    '#!/usr/bin/env node',
    `const d = require(${JSON.stringify(path.join(dir, 'data.json'))}); const a = process.argv.slice(2); const fs = require('fs');`,
    'const p = a.find(x => x.startsWith(\'repos/fx/fx/actions/\')) || \'\'; const lines = xs => { for (const x of xs) console.log(JSON.stringify(x)); process.exit(0); };',
    'const id = (/\\/runs\\/(\\d+)/.exec(p) || [])[1];',
    'const count = n => { try { return Number(fs.readFileSync(d.dir + \'/dl-\' + n, \'utf8\')); } catch { return 0; } };',
    'if (d.flip && count(d.flip.after) >= d.flip.downloads) d.runs[d.flip.run].run = { ...d.runs[d.flip.run].run, run_attempt: 2, conclusion: \'failure\' };',
    'if (a[0] === \'run\' && a[1] === \'download\' && d.runs[a[2]]) { fs.writeFileSync(d.dir + \'/dl-\' + a[2], String(count(a[2]) + 1)); fs.writeFileSync(a[a.indexOf(\'--dir\') + 1] + \'/tree.json\', JSON.stringify(d.runs[a[2]].tree)); process.exit(0); }',
    'const wf = (/\\/workflows\\/([^/]+)\\/runs\\?/.exec(p) || [])[1];',
    'if (wf) lines(Object.values(d.runs).filter(r => r.run.path === \'.github/workflows/\' + wf).map(r => r.run));',
    'if (id && d.runs[id] && p === \'repos/fx/fx/actions/runs/\' + id) { console.log(JSON.stringify(d.runs[id].run)); process.exit(0); }',
    'if (id && d.runs[id] && p.includes(\'/jobs?\')) lines(d.runs[id].jobs);',
    'if (id && d.runs[id] && p.includes(\'/artifacts?\')) lines([{ id: Number(id), name: d.runs[id].artifact, size_in_bytes: 200, expired: false }]);',
    'console.error(\'gh shim: unsupported \' + a.join(\' \')); process.exit(1);',
    '',
  ].join('\n'), { mode: 0o755 });
  process.env.PATH = `${dir}${path.delimiter}${savedPath ?? ''}`;
}

async function carried(repo: FixtureRepo) {
  const progress: string[] = [];
  const loaded = buildContext({ repoRoot: repo.work, base: 'main', policyFrom: 'base', allowRepoCommands: true, env: { ...process.env, ...repo.env }, progress: l => progress.push(l), cores: 16, testBackend: 'local' });
  if (!('ctx' in loaded)) throw new Error('fixture context refused');
  const file = await runPregate(loaded.ctx, { stage: 'tests' });
  const lanes = file.checks.find(c => c.id === 'lanes')!;
  return { lanes, carry: progress.find(l => l.startsWith('CI_CARRY: ')) ?? '', ran: (lanes.lines ?? []).find(l => l.startsWith('ran: ')) ?? '' };
}

const TEST_RUN: Run = { id: 100, workflow: 'free-tests.yml', job: 'unit', artifact: 'tested-tree', files: ['test/util.test.js'] };
const E2E_RUN: Run = { id: 101, workflow: 'e2e.yml', job: 'e2e', artifact: 'e2e-tree', files: ['test/retry.test.js'] };

describe.skipIf(process.platform === 'win32')('the CI carry unions every verified profile at the tree (GST-3381)', () => {
  // Value: protects=a second green workflow at the same tree shortens the local remainder;
  //   fails_when=the carry stops at the first verified profile and runs the E2E run's files again here;
  //   why_new=GST-3381 (a), relayed from gbrain branches with Test and E2E runs; seam=runPregate with a gh shim
  test('a green Test run and a green E2E run at the tree both count', async () => {
    const repo = fixture();
    ghShim(repo, [TEST_RUN, E2E_RUN]);
    const { lanes, carry, ran } = await carried(repo);
    expect(carry).toMatch(/^CI_CARRY: accepted ci-carry .* runs=100\/1 profiles=ci-reuse\/free-tests .* \+ ci-carry .* runs=101\/1 profiles=ci-reuse\/e2e /);
    expect(lanes.from_run?.files.sort()).toEqual(['test/retry.test.js', 'test/util.test.js']);
    expect(lanes.from_run?.receipt).toMatch(/ tests=8 runs=100\/1,101\/1 profiles=ci-reuse\/free-tests,ci-reuse\/e2e /);
    expect(ran).not.toContain('test/retry.test.js');
    expect(lanes.status).toBe('pass');
  }, 120_000);

  // Value: protects=the kept runs are read again once the union is built, as findCarry does (docs/pregate.md run evidence);
  //   fails_when=the Test run moves to a red attempt while the E2E run is verified and its stale files still count;
  //   why_new=GST-3381 cross-family trail read on #4671; seam=runPregate with a gh shim that flips run 100 after run 101's second download
  test('a run that moves to a new attempt while the other is verified refuses the union, and everything runs here', async () => {
    const repo = fixture();
    ghShim(repo, [TEST_RUN, E2E_RUN], { run: 100, after: 101, downloads: 2 });
    const { lanes, ran } = await carried(repo);
    expect(lanes.lines).toContainEqual(expect.stringMatching(/^REUSE: refused reason=run_changed — run 100 .*; every selected test runs here$/));
    expect(lanes.from_run).toBeUndefined();
    expect([ran.includes('test/util.test.js'), ran.includes('test/retry.test.js')]).toEqual([true, true]);
  }, 120_000);

  // Value: protects=only a verified run at this tree adds coverage; fails_when=a red run or a run of another tree shortens the remainder
  test('an E2E run that is red, or that tested another tree, adds nothing', async () => {
    for (const e2e of [{ ...E2E_RUN, conclusion: 'failure' }, { ...E2E_RUN, tree: 'f'.repeat(40) }]) {
      const repo = fixture();
      ghShim(repo, [TEST_RUN, e2e]);
      const { lanes, carry, ran } = await carried(repo);
      expect(carry).toMatch(/^CI_CARRY: accepted ci-carry .* runs=100\/1 profiles=ci-reuse\/free-tests [^+]*$/);
      expect(lanes.from_run?.files).toEqual(['test/util.test.js']);
      expect(ran).toContain('test/retry.test.js');
    }
  }, 240_000);
});
