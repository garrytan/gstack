/**
 * scripts/test-changes-report.ts and gstack-gate-diff --head over real git repos: a pull request's commits are read as
 * objects from a checkout that stays on the base, its removed and skipped tests are tagged, its edits to check files
 * are listed, and a checker failure is an error, never a quiet result.
 *
 * Value: protects=the Test changes report counts what a pull request did to its tests without checking it out;
 * fails_when=--head reads the working tree, a removed test or new skip goes uncounted, a gate-file edit is missed, a
 * clean pull request is flagged, or a failed run exits 0; why_new=the report and --head are new (GST-3386);
 * seam=real git and the real CLIs; no_claim=GitHub's fetch of refs/pull
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { gitArgvIn } from './helpers/scratch-repo';

const ROOT = path.resolve(import.meta.dir, '..');
const REPORT = path.join(ROOT, 'scripts', 'test-changes-report.ts');
const GATE_DIFF = path.join(ROOT, 'bin', 'gstack-gate-diff');
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

function tmp(prefix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(d);
  return d;
}
function git(dir: string, args: string[]): string {
  const r = gitArgvIn(dir, args, 10_000);
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${(r.stderr ?? '').toString()}`);
  return (r.stdout ?? '').toString().trim();
}
function write(dir: string, files: Record<string, string>): void {
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  }
}

const BASE_TEST = "import { test, expect } from 'bun:test';\ntest('adds', () => {\n  expect(1 + 1).toBe(2);\n});\ntest('subtracts', () => {\n  expect(2 - 1).toBe(1);\n});\n";

/** main holds a test file and a workflow; the candidate commit, never checked out, is `change` applied on top. */
function repo(change: Record<string, string>): { dir: string; base: string; head: string } {
  const dir = tmp('gstack-test-changes-');
  git(dir, ['init', '-q', '-b', 'main']);
  write(dir, { 'test/math.test.ts': BASE_TEST, '.github/workflows/ci.yml': 'name: ci\non: push\n', 'src/math.ts': 'export const one = 1;\n' });
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'seed']);
  const base = git(dir, ['rev-parse', 'HEAD']);
  git(dir, ['checkout', '-q', '-b', 'pr']);
  write(dir, change);
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'candidate']);
  const head = git(dir, ['rev-parse', 'HEAD']);
  git(dir, ['checkout', '-q', 'main']);
  return { dir, base, head };
}
function run(bin: string, cwd: string, args: string[]) {
  const r = spawnSync(process.execPath, ['--no-env-file', '--config=/dev/null', bin, ...args], {
    cwd, encoding: 'utf-8', timeout: 60_000, env: { ...process.env, GSTACK_HOME: tmp('gstack-test-changes-home-'), GSTACK_STATE_ROOT: '' },
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

describe('test-changes report over a fetched, never checked-out pull request', () => {
  test('a removed test, a new skip and a workflow edit are all reported, and the checkout stays on main', () => {
    const { dir, base, head } = repo({
      'test/math.test.ts': "import { test, expect } from 'bun:test';\ntest.skip('adds', () => {\n  expect(1 + 1).toBe(2);\n});\n",
      '.github/workflows/ci.yml': 'name: ci\non: [push, pull_request]\n',
    });
    const summary = path.join(tmp('gstack-test-changes-out-'), 'summary.md');
    const r = run(REPORT, dir, ['--base', base, '--head', head, '--summary-file', summary]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/^TEST_CHANGES: tagged=\{RH-1:\d+\} tests_added=1 tests_removed=2 gate_files=1 unread=0 candidate=[0-9a-f]{12}\.\.[0-9a-f]{12}\n$/);
    const md = fs.readFileSync(summary, 'utf8');
    expect(md).toContain('`.github/workflows/ci.yml`');
    expect(md).toContain('`test/math.test.ts`');
    expect(md).not.toContain('expect(1 + 1)');
    expect(git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('main');
    expect(fs.readFileSync(path.join(dir, 'test/math.test.ts'), 'utf8')).toBe(BASE_TEST);
  });

  test('negative control: a pull request that only adds a test and changes source is not flagged', () => {
    const { dir, base, head } = repo({
      'test/math.test.ts': BASE_TEST + "test('multiplies', () => {\n  expect(2 * 2).toBe(4);\n});\n",
      'src/math.ts': 'export const one = 1;\nexport const two = 2;\n',
    });
    const r = run(REPORT, dir, ['--base', base, '--head', head]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/^TEST_CHANGES: tagged=\{\} tests_added=1 tests_removed=0 gate_files=0 /);
  });

  test('a test file that git reads as binary is named as unread, never counted as a quiet pass', () => {
    const { dir, base, head } = repo({ 'test/math.test.ts': "import { test } from 'bun:test';\n\0\n" });
    const summary = path.join(tmp('gstack-test-changes-out-'), 'summary.md');
    const r = run(REPORT, dir, ['--base', base, '--head', head, '--summary-file', summary]);
    expect(r.status).toBe(0);
    expect(fs.readFileSync(summary, 'utf8')).toContain('Not read as text, so tests removed in them are not counted: `test/math.test.ts` (binary).');
  });

  test('a branch-name base resolves once: a stale local main adds no upstream check-file edits', () => {
    const { dir, base } = repo({ 'src/math.ts': 'export const one = 1;\n// z\n' });
    git(dir, ['checkout', '-q', '-b', 'upstream', base]);
    write(dir, { '.github/workflows/ci.yml': 'name: ci\non: [push, workflow_dispatch]\n' });
    git(dir, ['commit', '-q', '-am', 'upstream']);
    git(dir, ['remote', 'add', 'origin', dir]);
    git(dir, ['update-ref', 'refs/remotes/origin/main', git(dir, ['rev-parse', 'HEAD'])]);
    write(dir, { 'src/math.ts': 'export const one = 1;\nexport const three = 3;\n' });
    git(dir, ['commit', '-q', '-am', 'pr']);
    const head = git(dir, ['rev-parse', 'HEAD']);
    git(dir, ['checkout', '-q', 'main']);
    const r = run(REPORT, dir, ['--base', 'main', '--head', head]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/ gate_files=0 /);
  });

  test('--commit reads one commit the same way', () => {
    const { dir, head } = repo({ 'test/math.test.ts': "import { test } from 'bun:test';\n" });
    const r = run(REPORT, dir, ['--commit', head]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/tests_added=0 tests_removed=2 gate_files=0 /);
  });

  test('an unresolvable head is an error with exit 1, never a quiet report', () => {
    const { dir, base } = repo({ 'src/math.ts': 'export const one = 1;\n// x\n' });
    const r = run(REPORT, dir, ['--base', base, '--head', '0123456789abcdef0123456789abcdef01234567']);
    expect(r.status).toBe(1);
    expect(r.stdout).toBe('TEST_CHANGES: error\n');
    expect(r.stderr).toContain('gstack-gate-diff failed');
  });

  test('gate-diff refuses --head together with --commit', () => {
    const { dir, head } = repo({ 'src/math.ts': 'export const one = 1;\n// y\n' });
    const r = run(GATE_DIFF, dir, ['--commit', head, '--head', head]);
    expect(r.status).toBe(2);
    expect(r.stdout).toMatch(/^GATE_ERROR=internal reason=usage .*cannot be combined/);
  });
});
