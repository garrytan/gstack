/**
 * GST-3493: a pregate.json only speaks for the base it was taken against. `gstack-pregate verify --base <branch>` refuses
 * a record taken against another base, and /ship's finish passes its base, so a record cleared under a stacked base no
 * longer verifies after the pull request is retargeted at the same head. `gstack-pregate clear` refuses a base that already
 * contains the head (BASE_CONTAINS_HEAD), as a pregate run does, before it reads that base's policy.
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

async function stackedPregate(repo: FixtureRepo, fromRun?: RunCheck, stage: 'tests' | 'all' = 'tests'): Promise<{ file: PregateFile; progress: string[] }> {
  const progress: string[] = [];
  const loaded = buildContext({ repoRoot: repo.work, base: 'stack', policyFrom: 'base', allowRepoCommands: true, env: { ...process.env, ...repo.env }, progress: l => progress.push(l), cores: 4, testBackend: 'local' });
  if (!('ctx' in loaded)) throw new Error('fixture context refused');
  if (fromRun) loaded.ctx.fromRun = { ref: '200', check: fromRun };
  else loaded.ctx.ciCarry = false;
  return { file: await runPregate(loaded.ctx, { stage }), progress };
}

describe.skipIf(process.platform === 'win32')('a pregate.json answers only for its own base (GST-3493)', () => {
  // Value: protects=a record cleared under a stacked base stops verifying once the PR ships against main at the same head;
  //   fails_when=verify ignores the record's base, so a stacked clear (its policy and run profiles) passes for main;
  //   why_new=GST-3493, the base half of GST-3381's stacked clear; seam=the gstack-pregate bin's verify verb;
  //   no_claim=a record with no base field (older pregate runs) has nothing to compare, so --base keeps today's pass
  test('verify --base refuses a record taken against another base and passes when the bases match', async () => {
    const repo = stackedFixture();
    repo.git('remote', 'set-url', 'origin', 'https://github.com/fx/fx.git');
    const built = buildRunCheck(repo.work, null, true, 'stack');
    repo.git('remote', 'set-url', 'origin', repo.origin);
    if ('error' in built) throw new Error(built.error);
    const { run, jobs, tree, head } = greenRun(repo);
    const check: RunCheck = { ...built, repo: 'fx/fx', deps: { run: () => run, runsForHead: (_wf, sha) => (sha === head ? [run] : []), jobs: () => jobs, artifact: () => tree, commitTree: sha => repo.git('rev-parse', `${sha}^{tree}`) } };
    const { file } = await stackedPregate(repo, check, 'all');
    expect([file.base?.startsWith('origin/stack@'), file.verdict]).toEqual([true, 'requires-remote cleared']);
    const out = path.join(repo.work, '.gstack/tmp/pregate.json');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(file));
    const same = runBin(repo, 'gstack-pregate', ['verify', '--base', 'stack']);
    expect([same.status, same.out]).toEqual([EXIT.ok, expect.stringContaining('PREGATE_VERIFY: ok ')]);
    const retargeted = runBin(repo, 'gstack-pregate', ['verify', '--base', 'main']);
    expect([retargeted.status, retargeted.out]).toEqual([EXIT.fail, expect.stringContaining('PREGATE_VERIFY: refused PREGATE_STALE')]);
    expect(retargeted.err).toContain('pregate.json was recorded against origin/stack, but this ships against origin/main');
    expect(runBin(repo, 'gstack-pregate', ['verify']).status).toBe(EXIT.ok);
    const { base: _taken, ...older } = file;
    fs.writeFileSync(out, JSON.stringify(older));
    expect(runBin(repo, 'gstack-pregate', ['verify', '--base', 'main']).status).toBe(EXIT.ok);
  }, 120_000);

  // Value: protects=clear never reads a base's policy (and its repo commands) when that base already contains the head;
  //   fails_when=clear takes the stacked base's policy after the base merged the branch, as a pregate run would refuse;
  //   why_new=GST-3493 scope from #4689's trail read; seam=the gstack-pregate bin's clear verb with a gh shim
  test('clear refuses BASE_CONTAINS_HEAD once the stacked base already holds the recorded head, on a branch or detached', async () => {
    const repo = stackedFixture();
    const { file } = await stackedPregate(repo);
    const out = path.join(repo.work, '.gstack/tmp/pregate.json');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(file));
    repo.git('push', '-q', 'origin', 'feature:stack');
    repo.git('remote', 'set-url', 'origin', 'https://github.com/fx/fx.git');
    const r = runBin(repo, 'gstack-pregate', ['clear', '--remote', LANE, '--run', '200', '--allow-repo-commands'], ghShim(repo));
    expect([r.status, r.err]).toEqual([EXIT.refused, expect.stringContaining('(BASE_CONTAINS_HEAD')]);
    expect(r.err).toContain('origin/stack (');
    repo.git('checkout', '-q', '--detach');
    const detached = runBin(repo, 'gstack-pregate', ['clear', '--remote', LANE, '--run', '200', '--allow-repo-commands'], ghShim(repo));
    expect([detached.status, detached.err]).toEqual([EXIT.refused, expect.stringContaining('(BASE_CONTAINS_HEAD')]);
    expect(JSON.parse(fs.readFileSync(out, 'utf8')).requires_remote[0].receipt).toBeNull();
  }, 120_000);
});
