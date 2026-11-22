/**
 * GST-3381 (b): a pregate.json recorded against a stacked base (a branch other than origin/HEAD's) clears its remote gate
 * from that base's run profiles. `gstack-pregate clear --run` reads the base from the record it clears, and the CI carry
 * inside a `--base <branch>` run (what `gstack-ship-release accept --base` runs) clears against the same base. A
 * clear told another base with --base still refuses base_mismatch. The Actions API is a gh shim (bin) or a fake (library).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { EXIT, type PregateFile } from '../lib/headless-artifacts';
import { buildContext } from '../lib/pregate/context';
import { runPregate, type RunCheck } from '../lib/pregate/index';
import { buildRunCheck } from '../lib/pregate/run-check';
import type { ApiRun, RunProfile } from '../lib/run-evidence';
import { BASE_PREGATE, cleanup, commit, makeFixtureRepo, runBin, type FixtureRepo } from './helpers/pregate-fixture';

const repos: FixtureRepo[] = [];
afterEach(() => { while (repos.length) cleanup(repos.pop()!); });

const LANE = 'pregate.json/remote_gate';
const NAME = 'ci-reuse/free-tests';
const LOCAL_OS = process.platform === 'darwin' ? 'macOS' : 'Linux';
const PROFILE: RunProfile = { workflow: 'free-tests.yml', events: ['pull_request', 'workflow_dispatch'], jobs: ['unit'], artifact: 'tested-tree', os: LOCAL_OS };
const FREE = ['test/retry.test.js', 'test/util.test.js'];
const GATE_RUNS = { profiles: [NAME], inventory: 'printf "test/retry.test.js\\ntest/util.test.js\\n"', skipped: 'grep -E "^test/nightly/" "$PREGATE_FILES_FILE" || true' };

/** main and the stacked base `stack` both declare the profile; the feature branch sits on `stack` and touches two subjects. */
function stackedFixture(): FixtureRepo {
  const repo = makeFixtureRepo({ pregate: { ...BASE_PREGATE, remote_gate: 'node scripts/remote-gate.js', run_profiles: { [NAME]: PROFILE }, remote_gate_runs: GATE_RUNS } });
  repos.push(repo);
  repo.git('checkout', '-q', '-b', 'stack', 'main');
  commit(repo, { 'docs/stack.md': '# the stacked base\n' }, 'stacked base');
  repo.git('push', '-q', 'origin', 'stack');
  repo.git('checkout', '-q', 'feature');
  repo.git('reset', '-q', '--hard', 'stack');
  commit(repo, { 'lib/util.js': 'exports.add = (a, b) => a + b + 0;\n', 'lib/retry.js': 'exports.MAX_RETRIES = 3;\nexports.TIMEOUT_MS = 5000;\nexports.retry = (fn) => fn();\nexports.touched = true;\n' }, 'touch two subjects');
  return repo;
}

/** Run 200 of free-tests.yml at HEAD, green, finished ten minutes ago, its tree.json listing FREE. */
function greenRun(repo: FixtureRepo) {
  const head = repo.git('rev-parse', 'HEAD');
  const finished = new Date(Date.now() - 600_000).toISOString();
  const run: ApiRun = { id: 200, run_attempt: 1, status: 'completed', conclusion: 'success', event: 'workflow_dispatch', head_sha: head, path: '.github/workflows/free-tests.yml', created_at: finished, updated_at: finished, repository: { full_name: 'fx/fx' }, head_repository: { full_name: 'fx/fx' } };
  const jobs = [{ name: 'unit', conclusion: 'success', completed_at: finished }];
  const tree = { run_id: 200, run_attempt: 1, event: 'workflow_dispatch', sha: head, tree: repo.git('rev-parse', 'HEAD^{tree}'), os: [LOCAL_OS], files: FREE, tests: FREE.length * 4 };
  return { head, run, jobs, tree };
}

/** A gh on PATH that answers only the Actions reads ghRunDeps makes for run 200, from greenRun. */
function ghShim(repo: FixtureRepo): Record<string, string> {
  const dir = path.join(repo.root, 'gh-shim');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'data.json'), JSON.stringify(greenRun(repo)));
  fs.writeFileSync(path.join(dir, 'gh'), [
    '#!/usr/bin/env node',
    `const d = require(${JSON.stringify(path.join(dir, 'data.json'))}); const a = process.argv.slice(2); const fs = require('fs');`,
    'const p = a.find(x => x.startsWith(\'repos/\')) || \'\'; const lines = xs => { for (const x of xs) console.log(JSON.stringify(x)); process.exit(0); };',
    'if (a[0] === \'run\' && a[1] === \'download\' && a[2] === \'200\') { fs.writeFileSync(a[a.indexOf(\'--dir\') + 1] + \'/tree.json\', JSON.stringify(d.tree)); process.exit(0); }',
    'if (a[0] === \'api\' && p === \'repos/fx/fx/actions/runs/200\') { console.log(JSON.stringify(d.run)); process.exit(0); }',
    'if (a[0] === \'api\' && p.startsWith(\'repos/fx/fx/actions/runs/200/attempts/1/jobs?\')) lines(d.jobs);',
    'if (a[0] === \'api\' && p.startsWith(\'repos/fx/fx/actions/workflows/free-tests.yml/runs?head_sha=\')) lines(p.includes(d.head) ? [d.run] : []);',
    'if (a[0] === \'api\' && p.startsWith(\'repos/fx/fx/actions/runs/200/artifacts?\')) lines([{ id: 1, name: \'tested-tree\', size_in_bytes: 200, expired: false }]);',
    'console.error(\'gh shim: unsupported \' + a.join(\' \')); process.exit(1);',
    '',
  ].join('\n'), { mode: 0o755 });
  return { PATH: `${dir}${path.delimiter}${process.env.PATH ?? ''}` };
}

async function stackedPregate(repo: FixtureRepo, fromRun?: RunCheck): Promise<{ file: PregateFile; progress: string[] }> {
  const progress: string[] = [];
  const loaded = buildContext({ repoRoot: repo.work, base: 'stack', policyFrom: 'base', allowRepoCommands: true, env: { ...process.env, ...repo.env }, progress: l => progress.push(l), cores: 4, testBackend: 'local' });
  if (!('ctx' in loaded)) throw new Error('fixture context refused');
  if (fromRun) loaded.ctx.fromRun = { ref: '200', check: fromRun };
  else loaded.ctx.ciCarry = false;
  return { file: await runPregate(loaded.ctx, { stage: 'tests' }), progress };
}
const gate = (file: PregateFile) => file.requires_remote?.find(r => r.lane === LANE);

describe.skipIf(process.platform === 'win32')('a pregate.json recorded against a stacked base clears from that base (GST-3381)', () => {
  // Value: protects=a /ship on a branch whose base is not origin/HEAD's can clear its remote gate from a green CI run;
  //   fails_when=clear reads run profiles from origin/HEAD's branch and refuses base_mismatch (GSTA-724/725/726, Vorflux on rust-engine/main);
  //   why_new=GST-3381 (b); seam=the gstack-pregate bin with a gh shim
  test('clear --run reads the record\'s base; --base naming another branch still refuses base_mismatch', async () => {
    const repo = stackedFixture();
    const { file } = await stackedPregate(repo);
    expect(file.base).toStartWith('origin/stack@');
    expect(gate(file)?.receipt).toBeNull();
    const out = path.join(repo.work, '.gstack/tmp/pregate.json');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(file));
    repo.git('remote', 'set-url', 'origin', 'https://github.com/fx/fx.git');
    const copy = path.join(repo.work, '.gstack/tmp/pregate-other.json');
    fs.copyFileSync(out, copy);
    const env = ghShim(repo);
    const r = runBin(repo, 'gstack-pregate', ['clear', '--remote', LANE, '--run', '200', '--allow-repo-commands'], env);
    expect([r.status, r.err]).toEqual([EXIT.ok, expect.any(String)]);
    expect(r.out).toContain(`REUSE: accepted ${LANE} remote-gate tree=${file.tree.slice(0, 12)} tests=8 skipped=1 runs=200/1 profiles=${NAME} `);
    expect(JSON.parse(fs.readFileSync(out, 'utf8')).requires_remote[0].receipt).toStartWith(`remote-gate tree=${file.tree.slice(0, 12)} `);
    const other = runBin(repo, 'gstack-pregate', ['clear', '--remote', LANE, '--run', '200', '--base', 'main', '--out', copy, '--allow-repo-commands'], env);
    expect([other.status, other.err]).toEqual([EXIT.fail, expect.stringContaining('REUSE: refused reason=base_mismatch — pregate.json was recorded against origin/stack, but run profiles come from origin/main')]);
    expect(JSON.parse(fs.readFileSync(copy, 'utf8')).requires_remote[0].receipt).toBeNull();
    const bundle = runBin(repo, 'gstack-pregate', ['clear', '--remote', LANE, '--bundle-lane', 'free', '--base', 'main', '--out', copy], env);
    expect([bundle.status, bundle.err]).toEqual([EXIT.fail, expect.stringContaining('REUSE: refused reason=base_mismatch — pregate.json was recorded against origin/stack, but run profiles come from origin/main')]);
    expect(JSON.parse(fs.readFileSync(copy, 'utf8')).requires_remote[0].receipt).toBeNull();
  }, 120_000);

  // Value: protects=accept's pregate rerun (--base <stacked base>) clears the gate from the run it carried, as on main;
  //   fails_when=the carry's clear compares the record against origin/HEAD's branch and leaves the gate uncleared;
  //   why_new=GST-3381 (b), the same base check on the accept route; seam=runPregate with a fake run API
  test('the CI carry inside a --base run clears the gate against that base', async () => {
    const repo = stackedFixture();
    repo.git('remote', 'set-url', 'origin', 'https://github.com/fx/fx.git');
    const built = buildRunCheck(repo.work, null, true, 'stack');
    repo.git('remote', 'set-url', 'origin', repo.origin);
    if ('error' in built) throw new Error(built.error);
    const { run, jobs, tree, head } = greenRun(repo);
    const check: RunCheck = { ...built, repo: 'fx/fx', deps: { run: () => run, runsForHead: (_wf, sha) => (sha === head ? [run] : []), jobs: () => jobs, artifact: () => tree, commitTree: sha => repo.git('rev-parse', `${sha}^{tree}`) } };
    const { file, progress } = await stackedPregate(repo, check);
    const obligation = gate(file)!;
    expect(progress).not.toContainEqual(expect.stringContaining('base_mismatch'));
    expect([obligation.receipt, obligation.cleared_by]).toEqual([expect.stringMatching(new RegExp(`^remote-gate tree=${file.tree.slice(0, 12)} tests=8 skipped=1 runs=200/1 `)), 'ci-carry']);
    expect(file.verdict).toBe('requires-remote cleared');
  }, 120_000);
});
