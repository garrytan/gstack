/**
 * Windows checks by path (ship-90-90 plan D, GST-1135). Pins three things:
 *
 *   1. windows-smoke.yml stays the unfiltered Windows check on every pull
 *      request.
 *   2. windows-setup-e2e.yml starts only on install paths, and its
 *      windows-scope job keeps the two Windows jobs off a pull request whose
 *      only install change is package.json's version line (the merge-train
 *      stamp).
 *   3. windows-scoped-tests.yml runs the changed Windows-safe test files when
 *      a pull request touches path, file-name or process code. Its filter must
 *      catch #3758 (/freeze's check-freeze.sh, a hook path) and #3829 (a test
 *      that spawned Bun with --config=/dev/null), and pass over a docs-only
 *      and a pure-logic change. Its aggregate passes when nothing is in scope,
 *      so a skipped run still reports success.
 *
 * The filter and scope steps run here as the runner would run them: bash in a
 * two-commit git repository, with HEAD^1 as the pull request's base.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseWorkflow } from '../lib/pregate/workflows';
import { collectFreeTestFiles, curateWindowsSafe } from '../scripts/test-free-shards';

const ROOT = path.resolve(import.meta.dir, '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const SCOPED_FILE = 'windows-scoped-tests.yml';
const SETUP_FILE = 'windows-setup-e2e.yml';
const scopedText = read(`.github/workflows/${SCOPED_FILE}`);
const setupText = read(`.github/workflows/${SETUP_FILE}`);
const scoped = Bun.YAML.parse(scopedText) as any;
const setupE2e = Bun.YAML.parse(setupText) as any;
const smoke = Bun.YAML.parse(read('.github/workflows/windows-smoke.yml')) as any;
const toShell = (p: string) => p.split(path.sep).join('/');
const CAN_RUN = !!Bun.which('bash') && !!Bun.which('git');

const PKG = (version: string, deps = '"a": "1.0.0"') => `{\n  "name": "gstack",\n  "version": "${version}",\n  "dependencies": {\n    ${deps}\n  }\n}\n`;

function git(cwd: string, args: string[]): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 30_000 });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
}

/** A repository with a base commit and one change on top: HEAD^1 plays the pull request's base, as on the merge ref. */
function repo(base: Record<string, string>, change: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'windows-scope-'));
  const write = (files: Record<string, string>) => {
    for (const [rel, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), text);
    }
  };
  git(dir, ['init', '-q']);
  write(base);
  git(dir, ['add', '-A']);
  git(dir, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@gstack.test', 'commit', '-q', '-m', 'base']);
  write(change);
  git(dir, ['add', '-A']);
  git(dir, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@gstack.test', 'commit', '-q', '-m', 'change']);
  return dir;
}

/** GITHUB_OUTPUT lines, including name<<DELIMITER blocks. */
function parseOutputs(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const block = /^([\w-]+)<<(.+)$/.exec(lines[i]!);
    if (block) {
      const end = lines.indexOf(block[2]!, i + 1);
      out[block[1]!] = lines.slice(i + 1, end).join('\n');
      i = end;
    } else if (lines[i]!.includes('=')) {
      const at = lines[i]!.indexOf('=');
      out[lines[i]!.slice(0, at)] = lines[i]!.slice(at + 1);
    }
  }
  return out;
}

interface StepRun { status: number | null; stderr: string; outputs: Record<string, string>; summary: string; temp: string }

const TEMPS: string[] = [];
afterAll(() => { for (const dir of TEMPS) fs.rmSync(dir, { recursive: true, force: true }); });
const newTemp = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'windows-scope-temp-')); TEMPS.push(dir); return dir; };

/** Run one workflow step's script under bash with a fresh GITHUB_OUTPUT and summary; temp is RUNNER_TEMP, kept for a later step. */
function runStep(script: string, cwd: string, env: Record<string, string> = {}, temp = newTemp()): StepRun {
  const output = path.join(temp, 'github-output');
  const summary = path.join(temp, 'github-summary');
  fs.writeFileSync(output, '');
  fs.writeFileSync(summary, '');
  const r = spawnSync('bash', ['-c', script], {
    cwd, encoding: 'utf8', timeout: 30_000,
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? temp, GITHUB_EVENT_NAME: 'pull_request', RUNNER_TEMP: toShell(temp), GITHUB_OUTPUT: toShell(output), GITHUB_STEP_SUMMARY: toShell(summary), ...env },
  });
  return { status: r.status, stderr: r.stderr, outputs: parseOutputs(fs.readFileSync(output, 'utf8')), summary: fs.readFileSync(summary, 'utf8'), temp };
}

const step = (job: any, id: string) => job.steps.find((s: any) => s.id === id);
const filterScript: string = step(scoped.jobs['windows-scope'], 'filter').run;
const selectScript: string = step(scoped.jobs['windows-scope'], 'select').run;
const setupScopeScript: string = step(setupE2e.jobs['windows-scope'], 'scope').run;

// #3758 (v1.92.9.0, /freeze checks where an edit really lands): its changed files. Its Windows failure was in
// test/hook-scripts.test.ts, from check-freeze.sh's path handling (run 41243040943).
const PR_3758 = ['CHANGELOG.md', 'VERSION', 'agents-digest/gstack-AGENTS.md', 'careful/bin/hook-extract.sh', 'freeze/SKILL.md', 'freeze/SKILL.md.tmpl',
  'freeze/bin/check-freeze.sh', 'package.json', 'test/hook-scripts.test.ts'];
// #3829 (v1.92.61.0, risk classes cover child_process): its changed files, none named for paths or processes. Its
// Windows failure (nightly run 41420490350) was test/review-risk-linear.test.ts, a file it added, spawning Bun with
// --config=/dev/null: EINVAL on native Windows.
const PR_3829 = ['CHANGELOG.md', 'VERSION', 'agents-digest/gstack-AGENTS.md', 'docs/review-policy.md', 'lib/review-collect.ts', 'lib/review-depth.ts',
  'lib/review-risk.ts', 'lib/review-targeted.ts', 'package.json', 'test/fixtures/review-risk/gbrain-evals-289.json', 'test/helpers/free-fixtures-data.ts',
  'test/review-packets-removed.test.ts', 'test/review-risk-linear.test.ts', 'test/review-risk-routing.test.ts'];
const LINE_3829 = "        const r = spawnSync(process.execPath, ['--no-env-file', '--config=/dev/null', path.join(dir, 'print.ts')], { encoding: 'utf8', timeout: 30_000 });";

/** Every file of a pull request with a neutral one-line edit, package.json as a version bump, plus the given lines. */
function prRepo(files: string[], lines: Record<string, string> = {}) {
  const base: Record<string, string> = {};
  const change: Record<string, string> = {};
  for (const file of files) {
    base[file] = file === 'package.json' ? PKG('1.0.0') : 'unchanged\n';
    change[file] = file === 'package.json' ? PKG('1.0.1') : `unchanged\nedited\n${lines[file] ?? ''}\n`;
  }
  return repo(base, change);
}

describe('windows-smoke stays on every pull request', () => {
  test('no paths filter, no job condition, one job', () => {
    expect(smoke.on.pull_request).toEqual({ branches: ['main'] });
    expect(smoke.on.push).toEqual({ branches: ['main'] });
    expect(Object.keys(smoke.jobs)).toEqual(['windows-smoke']);
    expect(smoke.jobs['windows-smoke'].if).toBeUndefined();
    expect(smoke.jobs['windows-smoke'].needs).toBeUndefined();
  });

  test('no Windows job that can skip is a required check, and the scoped aggregate always reports', () => {
    const required = JSON.parse(read('.gstack/ship-policy.json')).changelog_fragments.required_checks as string[];
    expect(required).toContain('windows-smoke');
    for (const name of ['windows-scope', 'windows-setup', 'held-install-journey', 'windows-scoped-shard', 'Windows Setup E2E']) expect(required).not.toContain(name);
    expect(scoped.jobs['windows-scoped-tests'].if).toBe('always()');
  });
});

describe('Windows Setup E2E runs by install path', () => {
  const paths: string[] = setupE2e.on.pull_request.paths;

  test('pull requests on install paths and dispatch only; every Windows job waits on windows-scope', () => {
    expect(Object.keys(setupE2e.on).sort()).toEqual(['pull_request', 'workflow_dispatch']);
    expect(setupE2e.on.pull_request.branches).toEqual(['main']);
    for (const p of ['setup', 'setup.ps1', 'package.json', 'bun.lock', 'gstack-upgrade/**', 'bin/gstack-config', 'bin/gstack-patch-names',
      'bin/gstack-state-root.sh', 'bin/gstack-migrate-claude-code', 'hosts/claude/hooks/**', 'docs/troubleshooting.md', `.github/workflows/${SETUP_FILE}`]) expect(paths).toContain(p);
    expect(new Set(paths).size).toBe(paths.length);
    for (const p of paths.filter(p => !p.includes('*'))) expect([p, fs.existsSync(path.join(ROOT, p))]).toEqual([p, true]);
    const scope = setupE2e.jobs['windows-scope'];
    expect(scope['runs-on']).toBe('ubuntu-24.04');
    expect(scope.steps[0].with).toEqual({ 'fetch-depth': 2, 'persist-credentials': false });
    const windowsJobs = Object.keys(setupE2e.jobs).filter(name => name !== 'windows-scope');
    expect(windowsJobs).toEqual(['windows-setup', 'held-install-journey']);
    for (const name of windowsJobs) {
      expect([name, setupE2e.jobs[name]['runs-on'], setupE2e.jobs[name].needs, setupE2e.jobs[name].if])
        .toEqual([name, 'windows-latest', 'windows-scope', "needs.windows-scope.outputs.install == 'true'"]);
    }
  });

  test("windows-scope's install list is the paths list", () => {
    const list = setupScopeScript.slice(setupScopeScript.indexOf("<<'PATHS'\n") + 10, setupScopeScript.indexOf('\nPATHS\n')).split('\n');
    expect(list).toEqual(paths);
  });

  test('pregate still reads windows-setup as a Windows lane obligation (no condition keys on a dispatch input)', () => {
    const lanes = parseWorkflow(SETUP_FILE, setupText, 'linux').filter(l => l.runsTests);
    expect(lanes.map(l => [l.job, l.manual, l.tier])).toContainEqual(['windows-setup', false, 'platform']);
  });

  test.skipIf(!CAN_RUN)('a version-only package.json change starts no Windows job; any other install change does', () => {
    const scope = (base: Record<string, string>, change: Record<string, string>) => {
      const dir = repo(base, change);
      try {
        const r = runStep(setupScopeScript, dir);
        expect(r.status, r.stderr).toBe(0);
        return r.outputs.install;
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    };
    const base = { 'package.json': PKG('1.0.0'), setup: '#!/bin/bash\n', 'lib/x.ts': 'export const x = 1;\n', 'hosts/claude/hooks/a/b.ts': 'a\n' };
    expect(scope(base, { 'package.json': PKG('1.0.1'), 'lib/x.ts': 'export const x = 2;\n' })).toBe('false');
    expect(scope(base, { 'package.json': PKG('1.0.1', '"a": "1.0.1"') })).toBe('true');
    expect(scope(base, { 'package.json': PKG('1.0.1'), setup: '#!/bin/bash\necho changed\n' })).toBe('true');
    expect(scope(base, { 'hosts/claude/hooks/a/b.ts': 'b\n' })).toBe('true');
    expect(scope({ 'package.json': PKG('1.0.0', '"version": "1.0.0"') }, { 'package.json': PKG('1.0.0', '"version": "1.0.1"') })).toBe('true');
    const dispatched = runStep(setupScopeScript, ROOT, { GITHUB_EVENT_NAME: 'workflow_dispatch' });
    expect([dispatched.status, dispatched.outputs.install]).toEqual([0, 'true']);
  });
});

describe('the path-scoped Windows shard on pull requests', () => {
  test('every pull request runs the cheap scope job; a dispatch names its files; read-only and secretless', () => {
    expect(Object.keys(scoped.on).sort()).toEqual(['pull_request', 'workflow_dispatch']);
    expect(scoped.on.pull_request).toEqual({ branches: ['main'] });
    expect(scoped.on.workflow_dispatch.inputs.files).toMatchObject({ type: 'string', required: true });
    expect(scoped.permissions).toEqual({ contents: 'read' });
    expect(scopedText).not.toContain('secrets.');
    expect(scopedText).not.toContain('pull_request_target');
    expect(scoped.concurrency.group).toBe('windows-scoped-tests-${{ github.event.pull_request.number || github.run_id }}');
    const scope = scoped.jobs['windows-scope'];
    expect(scope['runs-on']).toBe('ubuntu-24.04');
    expect(scope.steps[0].with).toEqual({ 'fetch-depth': 2, 'persist-credentials': false });
    const shard = scoped.jobs['windows-scoped-shard'];
    expect(shard['runs-on']).toBe('windows-latest');
    expect(shard.needs).toBe('windows-scope');
    expect(shard.steps[0].with).toEqual({ 'persist-credentials': false });
    const run = shard.steps.find((s: any) => s.name === 'Run the scoped Windows-safe test files');
    expect(run.env.FILES).toBe('${{ inputs.files || needs.windows-scope.outputs.files }}');
    expect(run.env.GSTACK_FREE_RETRY_FLAKY).toBe('1');
    expect(run.run).toContain('bun run scripts/test-free-shards.ts --files-from "$RUNNER_TEMP/windows-scoped-files.txt"');
    expect(scoped.jobs['windows-scoped-tests'].needs).toEqual(['windows-scope', 'windows-scoped-shard']);
  });

  test('pregate reads the scoped shard as manual, so it adds no remote-clear obligation', () => {
    const lanes = parseWorkflow(SCOPED_FILE, scopedText, 'linux').filter(l => l.runsTests);
    expect(lanes.map(l => [l.job, l.manual])).toEqual([['windows-scoped-shard', true]]);
  });

  test("#3758's and #3829's failing test files are in the curated Windows-safe subset", () => {
    const { safe } = curateWindowsSafe(collectFreeTestFiles(ROOT), ROOT);
    expect(safe).toContain('test/hook-scripts.test.ts');
    expect(safe).toContain('test/review-risk-linear.test.ts');
  });

  const CAN_SELECT = CAN_RUN && !!Bun.which('jq');
  /** Filter, then select with a stub bun whose curated plan holds the given files. */
  function scopeJob(dir: string, curated: string[]) {
    const filter = runStep(filterScript, dir);
    expect(filter.status, filter.stderr).toBe(0);
    const scope = fs.readFileSync(path.join(filter.temp, 'windows-scope'), 'utf8');
    if (filter.outputs.windows !== 'true') return { windows: filter.outputs.windows, scope, files: undefined as string | undefined };
    const bin = path.join(filter.temp, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'bun'), '#!/bin/sh\nwhile [ $# -gt 0 ]; do [ "$1" = --ci-plan ] && printf \'%s\' "$PLAN_JSON" > "$2"; shift; done\necho \'{"shard":[1]}\'\n', { mode: 0o755 });
    const plan = JSON.stringify({ version: 1, revision: 'r', shards: [{ shard: 1, predictedMs: 1, files: curated }], id: 'x' });
    const select = runStep(selectScript, dir, { PATH: `${toShell(bin)}:${process.env.PATH}`, PLAN_JSON: plan }, filter.temp);
    expect(select.status, select.stderr).toBe(0);
    return { windows: filter.outputs.windows, scope, files: select.outputs.files };
  }
  const CURATED = ['test/hook-scripts.test.ts', 'test/review-risk-linear.test.ts', 'test/review-risk-routing.test.ts'];

  test.skipIf(!CAN_SELECT)('the select step reads the real curated plan: a changed Windows-safe test is picked, a POSIX-only one is not', () => {
    const temp = newTemp();
    fs.writeFileSync(path.join(temp, 'changed-files'), 'freeze/bin/check-freeze.sh\ntest/hook-scripts.test.ts\ntest/windows-path-scope-workflow.test.ts\n');
    const select = runStep(selectScript, ROOT, { PATH: `${toShell(path.dirname(process.execPath))}:${process.env.PATH}` }, temp);
    expect(select.status, select.stderr).toBe(0);
    expect(select.outputs.files).toBe('test/hook-scripts.test.ts');
  }, 60_000);

  test.skipIf(!CAN_SELECT)('#3758: the hook paths put it in scope and the Windows job runs test/hook-scripts.test.ts', () => {
    const dir = prRepo(PR_3758);
    try {
      const job = scopeJob(dir, CURATED);
      expect(job.windows).toBe('true');
      expect(job.scope).toContain('path: careful/bin/hook-extract.sh');
      expect(job.scope).toContain('path: freeze/bin/check-freeze.sh');
      expect(job.files).toBe('test/hook-scripts.test.ts');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test.skipIf(!CAN_SELECT)('#3829: no path names it; the spawn line it added puts it in scope and the job runs its changed tests', () => {
    const dir = prRepo(PR_3829, { 'test/review-risk-linear.test.ts': LINE_3829 });
    try {
      const job = scopeJob(dir, CURATED);
      expect(job.windows).toBe('true');
      expect(job.scope.trim().split('\n')).toEqual([`content: test/review-risk-linear.test.ts: +${LINE_3829}`]);
      expect(job.files).toBe('test/review-risk-linear.test.ts\ntest/review-risk-routing.test.ts');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test.skipIf(!CAN_SELECT)('negative controls: a docs-and-stamp change and a pure-logic change start no Windows job', () => {
    for (const [files, lines] of [
      [['CHANGELOG.md', 'VERSION', 'package.json', 'docs/support-tiers.md', 'changelog.d/x.md'], {}],
      [['lib/review-depth.ts', 'test/review-depth.test.ts'], { 'lib/review-depth.ts': 'export const LIMIT = 3;', 'test/review-depth.test.ts': '  expect(LIMIT).toBe(3);' }],
    ] as Array<[string[], Record<string, string>]>) {
      const dir = prRepo(files, lines);
      try {
        const job = scopeJob(dir, [...CURATED, 'test/review-depth.test.ts']);
        expect([files, job.windows, job.scope]).toEqual([files, 'false', '']);
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    }
  });

  test.skipIf(!CAN_SELECT)('in scope but no changed Windows-safe test file: no files, so no Windows job', () => {
    const dir = prRepo(['bin/gstack-example', 'test/posix-only.test.ts']);
    try {
      const job = scopeJob(dir, CURATED);
      expect([job.windows, job.files]).toEqual(['true', undefined]);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test.skipIf(!Bun.which('bash'))('the aggregate passes when nothing is in scope and otherwise requires the Windows job', () => {
    const aggregate = scoped.jobs['windows-scoped-tests'].steps[0];
    expect(aggregate.env).toEqual({ SCOPE_RESULT: '${{ needs.windows-scope.result }}', SHARD_RESULT: '${{ needs.windows-scoped-shard.result }}', FILES: '${{ inputs.files || needs.windows-scope.outputs.files }}' });
    const status = (env: Record<string, string>) => runStep(aggregate.run, ROOT, env).status;
    expect(status({ SCOPE_RESULT: 'success', SHARD_RESULT: 'skipped', FILES: '' })).toBe(0);
    expect(status({ SCOPE_RESULT: 'success', SHARD_RESULT: 'success', FILES: 'test/a.test.ts' })).toBe(0);
    expect(status({ SCOPE_RESULT: 'success', SHARD_RESULT: 'failure', FILES: 'test/a.test.ts' })).not.toBe(0);
    expect(status({ SCOPE_RESULT: 'success', SHARD_RESULT: 'cancelled', FILES: 'test/a.test.ts' })).not.toBe(0);
    expect(status({ SCOPE_RESULT: 'failure', SHARD_RESULT: 'skipped', FILES: '' })).not.toBe(0);
  });
});
