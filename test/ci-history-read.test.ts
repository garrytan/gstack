/**
 * Blobless checkouts on the PR and train path (GSTA-203 PR 5).
 *
 * A `filter: blob:none` checkout keeps every commit and tree but fetches an
 * older file's contents on demand, and that fetch can fail. Every history read
 * those jobs gate on must tell "absent" (the ref's tree does not list the path)
 * from "could not read" (a failed fetch, an unknown ref): the first keeps its
 * old meaning, the second fails with HISTORY_READ_FAILED. The fixtures here
 * are real blobless clones whose promisor remote is then made unreachable.
 *
 * The checkout-mode pin keeps every full-history checkout blobless except in
 * the workflows FULL_CLONE_WORKFLOWS names, each with its reason.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { readFragments } from '../lib/changelog-fragments';
import { HistoryReadError, readHistoryFile } from '../lib/history-read';
import { classifyTrainHead } from '../lib/version-gate-train';

const ROOT = path.resolve(import.meta.dir, '..');
const HELPER = path.join(ROOT, '.github', 'scripts', 'history-read.sh');
const WORKFLOWS = path.join(ROOT, '.github', 'workflows');
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-history-read-'));
const savedBackoff = process.env.HISTORY_READ_BACKOFF_SECONDS;
process.env.HISTORY_READ_BACKOFF_SECONDS = '0';
afterAll(() => {
  if (savedBackoff === undefined) delete process.env.HISTORY_READ_BACKOFF_SECONDS;
  else process.env.HISTORY_READ_BACKOFF_SECONDS = savedBackoff;
  fs.rmSync(SCRATCH, { recursive: true, force: true });
});

/** Workflows that keep full clones, by file name, each with its reason. */
const FULL_CLONE_WORKFLOWS: Record<string, string> = {
  'weekly-release.yml': 'release: cuts and tags from main; off the PR and train path and not yet dispatched once blobless',
  'cso-runtime-promote.yml': 'CSO image promotion; off the PR and train path and not yet dispatched once blobless',
  'cso-runtime-qualification.yml': 'CSO runtime qualification; off the PR and train path and not yet dispatched once blobless',
  'evals-periodic.yml': 'periodic evals; off the PR and train path and not yet dispatched once blobless',
  'evals-marathon.yml': 'marathon evals; off the PR and train path and not yet dispatched once blobless',
  'eval-sweep.yml': 'eval sweep; off the PR and train path and not yet dispatched once blobless',
  'free-durations-record.yml': 'duration recorder; off the PR and train path and not yet dispatched once blobless',
  'evals-main-backstop.yml': 'reads every train note blob (554 notes on refs/notes/gstack-trains at 5ba425a); a blobless clone fetches each on demand at about 0.58 s apiece, minutes more than the 10 s a blobless checkout saves on a job off the PR path',
};

/** The PR and train path jobs that check out blobless full history, by workflow. */
const BLOBLESS_JOBS: Record<string, string[]> = {
  'free-tests.yml': ['free-plan'],
  'version-gate.yml': ['check'],
  'evals.yml': ['route', 'screen-summary', 'plan-slices', 'eval-slices', 'eval-rerun', 'train-bisect', 'slices-report'],
};

const GIT_ID = ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', '-c', 'commit.gpgsign=false'];
function git(cwd: string, ...args: string[]) {
  return spawnSync('git', [...GIT_ID, ...args], { cwd, encoding: 'utf8', timeout: 30_000 });
}
function ok(cwd: string, ...args: string[]): string {
  const r = git(cwd, ...args);
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

interface Fixture { clone: string; one: string; two: string; cut: () => void }
/**
 * A source repository with commits one and two, and a blobless clone of it
 * checked out at one, so two's changed files are missing until fetched. `cut`
 * points the clone's promisor remote at a path that does not exist.
 */
function fixture(name: string, one: Record<string, string>, two: Record<string, string | null>): Fixture {
  const dir = path.join(SCRATCH, name);
  const src = path.join(dir, 'src');
  fs.mkdirSync(src, { recursive: true });
  ok(src, 'init', '-q', '-b', 'main');
  const write = (files: Record<string, string | null>) => {
    for (const [rel, text] of Object.entries(files)) {
      const target = path.join(src, rel);
      if (text === null) { fs.rmSync(target, { force: true }); continue; }
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, text);
    }
    ok(src, 'add', '-A');
  };
  write(one);
  ok(src, 'commit', '-q', '-m', 'one');
  write(two);
  ok(src, 'commit', '-q', '-m', 'two');
  ok(src, 'config', 'uploadpack.allowFilter', 'true');
  const clone = path.join(dir, 'clone');
  ok(dir, 'clone', '-q', '--filter=blob:none', '--no-local', '--no-checkout', `file://${src}`, clone);
  ok(clone, 'checkout', '-q', 'origin/main~1');
  return { clone, one: ok(clone, 'rev-parse', 'HEAD'), two: ok(clone, 'rev-parse', 'origin/main'), cut: () => { ok(clone, 'remote', 'set-url', 'origin', `file://${dir}/gone`); } };
}

const TRAIN = { gate_workflow: 'evals.yml', free_workflow: 'free-tests.yml', full_gate_check: 'gstack/full-gate', record_artifact: 'gstack-train-record', max_size: 5, fill_hours: 3, screen_selection: 'none', trial_reservation_usd: 1.5 };
const POLICY = '.gstack/ship-policy.json';
const ONE = { VERSION: '1.0.0.0\n', [POLICY]: JSON.stringify({ bump: 'patch' }), 'README.md': 'one\n' };

function helper(cwd: string, ...args: string[]) {
  return spawnSync('bash', [HELPER, ...args], { cwd, encoding: 'utf8', timeout: 60_000, env: { PATH: process.env.PATH ?? '', HOME: cwd, HISTORY_READ_BACKOFF_SECONDS: '0' } });
}
const missing = (fx: Fixture, rev: string, rel: string) => spawnSync('git', ['cat-file', '-e', `${rev}:${rel}`], { cwd: fx.clone, timeout: 30_000, env: { ...process.env, GIT_NO_LAZY_FETCH: '1' } }).status !== 0;

describe('history-read.sh and lib/history-read.ts on a blobless clone', () => {
  test('a listed file is read, its blob fetched on demand', () => {
    const fx = fixture('read', ONE, { VERSION: '1.0.0.1\n' });
    expect(missing(fx, fx.two, 'VERSION')).toBe(true);
    const r = helper(fx.clone, fx.two, 'VERSION');
    expect(r.stderr).toBe('');
    expect([r.status, r.stdout]).toEqual([0, '1.0.0.1\n']);
    expect(readHistoryFile(fx.clone, fx.one, 'VERSION')).toBe('1.0.0.0\n');
    const sub = path.join(fx.clone, 'sub');
    fs.mkdirSync(sub);
    expect(helper(sub, fx.one, POLICY)).toMatchObject({ status: 0, stdout: JSON.stringify({ bump: 'patch' }) });
    expect(readHistoryFile(sub, fx.one, POLICY)).toBe(JSON.stringify({ bump: 'patch' }));
  });

  test('a path the tree does not list is absent even with the remote gone', () => {
    const fx = fixture('absent', ONE, { [POLICY]: null });
    fx.cut();
    expect(helper(fx.clone, fx.two, POLICY, '--absent', 'null')).toMatchObject({ status: 0, stdout: 'null' });
    expect(helper(fx.clone, fx.two, POLICY)).toMatchObject({ status: 0, stdout: '' });
    expect(readHistoryFile(fx.clone, fx.two, POLICY)).toBeNull();
  });

  test('a blob that cannot be fetched fails after 3 tries with HISTORY_READ_FAILED, never as absent', () => {
    const fx = fixture('unreachable', ONE, { [POLICY]: JSON.stringify({ bump: 'patch', train: TRAIN }) });
    fx.cut();
    const r = helper(fx.clone, fx.two, POLICY, '--absent', 'null');
    expect(r.status).toBe(1);
    expect(r.stdout).toBe('');
    for (const part of [`::error::cannot read ${POLICY} at ${fx.two}.`, 'git show failed 3 time(s)', '(git version ', 'docs/troubleshooting.md#history-read-failed', '(HISTORY_READ_FAILED)']) expect(r.stderr).toContain(part);
    let thrown: unknown;
    try { readHistoryFile(fx.clone, fx.two, POLICY); } catch (e) { thrown = e; }
    expect(thrown).toBeInstanceOf(HistoryReadError);
    expect((thrown as HistoryReadError).code).toBe('HISTORY_READ_FAILED');
    for (const part of [`cannot read ${POLICY} at ${fx.two}.`, 'git show failed 3 times', '(git version ', '#history-read-failed', '(HISTORY_READ_FAILED)']) expect((thrown as Error).message).toContain(part);
    expect(fs.readFileSync(path.join(ROOT, 'docs', 'troubleshooting.md'), 'utf8')).toContain('<a id="history-read-failed"></a>');
  });

  test('a ref that does not resolve fails instead of reading as absent', () => {
    const fx = fixture('bad-ref', ONE, { VERSION: '1.0.0.1\n' });
    const r = helper(fx.clone, 'no-such-ref', 'VERSION', '--absent', '0.0.0.0');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('cannot read VERSION at no-such-ref. git ls-tree failed');
    expect(() => readHistoryFile(fx.clone, 'no-such-ref', 'VERSION')).toThrow('(HISTORY_READ_FAILED)');
    expect(helper(fx.clone, 'only-one-arg').status).toBe(2);
  });

  test('the Version Gate classifies a head whose base policy cannot be fetched as invalid; an absent base policy stays off', () => {
    const unreadable = fixture('gate-unreadable', ONE, { [POLICY]: JSON.stringify({ bump: 'patch', train: TRAIN }) });
    unreadable.cut();
    const kind = classifyTrainHead({ repoRoot: unreadable.clone, baseRef: 'main', head: unreadable.one });
    expect(kind.kind).toBe('invalid');
    expect(kind.kind === 'invalid' && kind.reason).toContain(`cannot read ${POLICY} at origin/main.`);
    expect(kind.kind === 'invalid' && kind.reason).toContain('(HISTORY_READ_FAILED)');
    const absent = fixture('gate-absent', ONE, { [POLICY]: null });
    absent.cut();
    expect(classifyTrainHead({ repoRoot: absent.clone, baseRef: 'main', head: absent.one })).toEqual({ kind: 'off' });
  });

  test('the fragment reader fails loudly when the base CHANGELOG cannot be fetched, and treats an absent one as nothing released', () => {
    const fx = fixture('fragments', { ...ONE, 'CHANGELOG.md': '# Changelog\n\n## [1.0.0.0]\n\n- one\n', 'changelog.d/pr.md': '- the PR entry\n' }, { 'CHANGELOG.md': '# Changelog\n\n## [1.0.0.1]\n\n- two\n\n## [1.0.0.0]\n\n- one\n' });
    fx.cut();
    expect(() => readFragments(fx.clone, fx.one, 'changelog.d', fx.two, 'CHANGELOG.md', 'skip')).toThrow(HistoryReadError);
    expect(readFragments(fx.clone, fx.one, 'changelog.d', fx.two, 'NO-CHANGELOG.md', 'skip').errors).toEqual([]);
  });
});

type Step = { name?: string; uses?: string; run?: string; with?: Record<string, unknown> };
type Workflow = { jobs: Record<string, { steps?: Step[] }> };
const workflow = (file: string) => Bun.YAML.parse(fs.readFileSync(path.join(WORKFLOWS, file), 'utf8')) as Workflow;
const stepOf = (file: string, job: string, name: string) => workflow(file).jobs[job]!.steps!.find(st => st.name === name)!;

describe.skipIf(!Bun.which('jq') || !Bun.which('bash'))('the workflow steps that read history fail loudly', () => {
  function runStep(script: string, fx: Fixture, env: Record<string, string>, helperAt = '.github/scripts') {
    fs.mkdirSync(path.join(fx.clone, helperAt), { recursive: true });
    fs.copyFileSync(HELPER, path.join(fx.clone, helperAt, 'history-read.sh'));
    const bin = path.join(fx.clone, '.stub-bin');
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, 'sleep'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const out = path.join(fx.clone, '.github-output');
    fs.writeFileSync(out, '');
    const r = spawnSync('bash', ['-e', '-c', script], { cwd: fx.clone, encoding: 'utf8', timeout: 60_000,
      env: { PATH: `${bin}:${process.env.PATH ?? ''}`, HOME: fx.clone, HISTORY_READ_BACKOFF_SECONDS: '0', GITHUB_OUTPUT: out, GITHUB_STEP_SUMMARY: path.join(fx.clone, '.summary'), ...env } });
    const outputs = Object.fromEntries(fs.readFileSync(out, 'utf8').split('\n').filter(Boolean).map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
    return { status: r.status, log: r.stdout + r.stderr, outputs };
  }
  const policySteps = [
    { file: 'evals.yml', job: 'route', name: 'Read the train policy (base revision)', env: (fx: Fixture) => ({ BASE_SHA: fx.two, DEFAULT_BRANCH: 'main' }) },
    { file: 'evals-main-backstop.yml', job: 'backstop', name: 'Read the train policy (main)', env: (fx: Fixture) => ({ GITHUB_SHA: fx.two }) },
  ];

  for (const { file, job, name, env } of policySteps) {
    test(`${file} ${job}: an unfetchable policy fails, a malformed one fails, an absent one routes as before`, () => {
      const script = stepOf(file, job, name).run!;
      expect(script, 'the policy read runs no repository code: git and jq only').not.toMatch(/\.github\/scripts|\bbun\b/);
      expect(script).not.toContain('|| true');
      expect(script).not.toContain('2>/dev/null');

      const trained = { [POLICY]: JSON.stringify({ bump: 'patch', train: TRAIN }) };
      const reachable = fixture(`${job}-reachable`, ONE, trained);
      expect(runStep(script, reachable, env(reachable))).toMatchObject({ status: 0, outputs: { train: 'true' } });
      const unreadable = fixture(`${job}-unreadable`, ONE, trained);
      unreadable.cut();
      const failed = runStep(script, unreadable, env(unreadable));
      expect(failed.status).not.toBe(0);
      expect(failed.log).toContain('(HISTORY_READ_FAILED)');
      expect(failed.outputs).toEqual({});

      const malformed = fixture(`${job}-malformed`, ONE, { [POLICY]: '{not json' });
      const bad = runStep(script, malformed, env(malformed));
      expect(bad.status).not.toBe(0);
      expect(bad.log).toContain(`${malformed.two}:${POLICY} is not valid JSON`);

      const absent = fixture(`${job}-absent`, ONE, { [POLICY]: null });
      absent.cut();
      expect(runStep(script, absent, env(absent))).toMatchObject({ status: 0, outputs: { train: 'false' } });
    });
  }

  test('version-gate.yml Read versions: the base VERSION is read, an absent one is 0.0.0.0, a failed fetch fails', () => {
    const script = stepOf('version-gate.yml', 'check', 'Read versions').run!
      .replace('${{ github.event.pull_request.base.ref }}', 'main');
    expect(script).not.toContain('|| true');
    expect(script).not.toContain('2>/dev/null');

    const bumped = fixture('gate-bumped', ONE, { VERSION: '1.0.0.1\n' });
    expect(runStep(script, bumped, {}, '.version-gate/.github/scripts')).toMatchObject({ status: 0, outputs: { pr_version: '1.0.0.0', base_version: '1.0.0.1', base_ref: 'main' } });

    const unversioned = fixture('gate-unversioned', ONE, { VERSION: null });
    expect(runStep(script, unversioned, {}, '.version-gate/.github/scripts').outputs.base_version).toBe('0.0.0.0');

    bumped.cut();
    const failed = runStep(script, bumped, {}, '.version-gate/.github/scripts');
    expect(failed.status).not.toBe(0);
    expect(failed.log).toContain('git fetch origin main failed 3 times');
    expect(failed.log).toContain('(HISTORY_READ_FAILED)');
  });
});

describe('checkout mode on the PR and train path', () => {
  const files = fs.readdirSync(WORKFLOWS).filter(f => /\.ya?ml$/.test(f)).sort();

  test('every full-history checkout is blobless unless its workflow keeps full clones for a named reason', () => {
    const problems: string[] = [];
    const fullHistory = new Set<string>();
    for (const file of files) {
      const text = fs.readFileSync(path.join(WORKFLOWS, file), 'utf8');
      const checkoutLines = text.split('\n').flatMap((line, i) => (/^\s*(-\s+)?uses:\s*actions\/checkout@/.test(line) ? [i + 1] : []));
      const steps = Object.entries((Bun.YAML.parse(text) as Workflow).jobs ?? {}).flatMap(([job, j]) => (j.steps ?? []).filter(st => st.uses?.startsWith('actions/checkout@')).map(st => ({ job, st })));
      expect(steps.length, file).toBe(checkoutLines.length);
      steps.forEach(({ job, st }, i) => {
        const depth = st.with?.['fetch-depth'];
        if (!(depth === 0 || depth === '0' || (typeof depth === 'string' && depth.includes("'0'")))) return;
        fullHistory.add(file);
        const at = `.github/workflows/${file}:${checkoutLines[i]}`;
        if (FULL_CLONE_WORKFLOWS[file]) {
          if (st.with?.filter !== undefined) problems.push(`${at}: job ${job} sets filter but ${file} is in FULL_CLONE_WORKFLOWS; remove one or the other`);
          return;
        }
        if (st.with?.filter !== 'blob:none') problems.push(`${at}: job ${job} checks out full history without a blobless filter. Add \`filter: blob:none\` under its \`with:\`, or name ${file} in FULL_CLONE_WORKFLOWS (test/ci-history-read.test.ts) with the reason it needs every blob.`);
      });
    }
    expect(problems).toEqual([]);
    for (const [file, reason] of Object.entries(FULL_CLONE_WORKFLOWS)) {
      expect(reason.length, file).toBeGreaterThan(20);
      expect(fullHistory.has(file), `${file} has no full-history checkout left; drop it from FULL_CLONE_WORKFLOWS`).toBe(true);
    }
  });

  test('the PR and train path jobs check out blobless full history', () => {
    for (const [file, jobs] of Object.entries(BLOBLESS_JOBS)) {
      for (const job of jobs) {
        const checkout = workflow(file).jobs[job]!.steps!.find(st => st.uses?.startsWith('actions/checkout@'))!;
        expect(checkout.with?.filter, `${file} ${job}`).toBe('blob:none');
      }
    }
  });

  test('the eval image asserts its Git makes a blobless clone and fetches a missing blob', () => {
    const dockerfile = fs.readFileSync(path.join(ROOT, '.github', 'docker', 'Dockerfile.ci'), 'utf8');
    for (const part of ['git clone -q --filter=blob:none --no-local', 'config remote.origin.promisor)" = true', 'GIT_NO_LAZY_FETCH=1 git -C "$d/clone" cat-file -e HEAD~1:f', 'show HEAD~1:f)" = one']) expect(dockerfile).toContain(part);
  });
});
