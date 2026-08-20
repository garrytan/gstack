import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { execFileSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// P4 first-run scaffold (activation lift). Two surfaces under test:
//   1. bin/gstack-first-task-detect — classifies a repo into ONE enum bucket.
//   2. The unified first-run-guidance preamble wiring (generated into SKILL.md).

const ROOT = path.join(import.meta.dir, '..');
const DETECT = path.join(ROOT, 'bin', 'gstack-first-task-detect');

// The complete, closed set the detector is ever allowed to emit. The eval-safety
// guarantee is that nothing outside this set ever reaches the preamble.
const ENUM = new Set([
  'greenfield', 'code_node', 'code_python', 'code_rust', 'code_go',
  'code_ruby', 'code_ios', 'branch_ahead', 'dirty_default', 'clean_default', 'nongit',
]);

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@e.x',
  GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@e.x',
};

function detect(cwd: string): string {
  return execFileSync(DETECT, [], { cwd, encoding: 'utf-8', env: GIT_ENV }).trim();
}
function git(cwd: string, args: string) {
  execSync(`git ${args}`, { cwd, env: GIT_ENV, stdio: 'ignore' });
}

let tmp: string;
beforeAll(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ftd-')); });
afterAll(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

function freshRepo(name: string): string {
  const d = path.join(tmp, name);
  fs.mkdirSync(d, { recursive: true });
  git(d, 'init -q -b main');
  return d;
}

describe('gstack-first-task-detect — bucket classification', () => {
  test('non-git directory → nongit', () => {
    const d = path.join(tmp, 'plain'); fs.mkdirSync(d, { recursive: true });
    expect(detect(d)).toBe('nongit');
  });

  test('git repo, no commits → greenfield', () => {
    expect(detect(freshRepo('green'))).toBe('greenfield');
  });

  test('Node project with a commit → code_node', () => {
    const d = freshRepo('node');
    fs.writeFileSync(path.join(d, 'package.json'), '{"name":"x"}');
    git(d, 'add -A'); git(d, 'commit -qm init');
    expect(detect(d)).toBe('code_node');
  });

  test('Python project with a commit → code_python', () => {
    const d = freshRepo('py');
    fs.writeFileSync(path.join(d, 'pyproject.toml'), '[project]\nname="x"');
    git(d, 'add -A'); git(d, 'commit -qm init');
    expect(detect(d)).toBe('code_python');
  });

  // The remaining language markers (a typo in any would ship undetected).
  for (const [name, file, token] of [
    ['Rust', 'Cargo.toml', 'code_rust'],
    ['Go', 'go.mod', 'code_go'],
    ['Ruby', 'Gemfile', 'code_ruby'],
  ] as const) {
    test(`${name} project with a commit → ${token}`, () => {
      const d = freshRepo(`lang-${token}`);
      fs.writeFileSync(path.join(d, file), 'x');
      git(d, 'add -A'); git(d, 'commit -qm init');
      expect(detect(d)).toBe(token);
    });
  }

  test('iOS project (.xcodeproj) with a commit → code_ios', () => {
    const d = freshRepo('ios');
    fs.mkdirSync(path.join(d, 'App.xcodeproj'));
    fs.writeFileSync(path.join(d, 'App.xcodeproj', 'project.pbxproj'), '// x');
    git(d, 'add -A'); git(d, 'commit -qm init');
    expect(detect(d)).toBe('code_ios');
  });

  // Precedence (the detector's most fragile logic): branch-state buckets must
  // win over language markers, so a real repo isn't mislabeled "verify tests".
  test('feature branch ahead + package.json → branch_ahead (not code_node)', () => {
    const origin = freshRepo('prec-origin');
    git(origin, 'commit -qm base --allow-empty');
    const clone = path.join(tmp, 'prec-clone');
    git(tmp, `clone -q ${origin} prec-clone`);
    fs.writeFileSync(path.join(clone, 'package.json'), '{"name":"x"}');
    git(clone, 'checkout -q -b feature');
    git(clone, 'add -A'); git(clone, 'commit -qm work');
    expect(detect(clone)).toBe('branch_ahead');
  });

  test('dirty default branch + package.json → dirty_default (not code_node)', () => {
    const d = freshRepo('prec-dirty');
    fs.writeFileSync(path.join(d, 'package.json'), '{"name":"x"}');
    git(d, 'add -A'); git(d, 'commit -qm init');
    fs.writeFileSync(path.join(d, 'package.json'), '{"name":"x","v":2}');
    expect(detect(d)).toBe('dirty_default');
  });

  test('feature branch ahead of origin → branch_ahead', () => {
    const origin = freshRepo('origin');
    git(origin, 'commit -qm base --allow-empty');
    const clone = path.join(tmp, 'clone');
    git(tmp, `clone -q ${origin} clone`);
    git(clone, 'checkout -q -b feature');
    fs.writeFileSync(path.join(clone, 'f.txt'), 'x');
    git(clone, 'add -A'); git(clone, 'commit -qm work');
    expect(detect(clone)).toBe('branch_ahead');
  });

  test('uncommitted changes on default branch → dirty_default', () => {
    const d = freshRepo('dirty');
    fs.writeFileSync(path.join(d, 'a.txt'), 'x');
    git(d, 'add -A'); git(d, 'commit -qm init');
    fs.writeFileSync(path.join(d, 'a.txt'), 'changed');
    // No recognized language marker, so the dirty-default branch must win.
    expect(detect(d)).toBe('dirty_default');
  });

  test('clean default branch, 5+ commits, no language marker → clean_default', () => {
    const d = freshRepo('clean');
    for (let i = 0; i < 6; i++) git(d, `commit -qm c${i} --allow-empty`);
    expect(detect(d)).toBe('clean_default');
  });
});

describe('gstack-first-task-detect — contract', () => {
  test('output is always a whitelisted enum token or empty (eval-safe)', () => {
    for (const name of ['plain', 'green', 'node', 'py', 'clone', 'dirty', 'clean']) {
      const out = detect(path.join(tmp, name));
      if (out !== '') expect(ENUM.has(out)).toBe(true);
    }
  });

  test('detector is executable', () => {
    expect(fs.statSync(DETECT).mode & 0o111).toBeGreaterThan(0);
  });
});

describe('first-run-guidance preamble wiring (generated)', () => {
  const md = fs.readFileSync(path.join(ROOT, 'ship', 'SKILL.md'), 'utf-8');

  test('detection is gated to the first-ever run only (ACTIVATED=no, not headless)', () => {
    expect(md).toContain('if [ "$_ACTIVATED" = "no" ] && [ "$_SESSION_KIND" != "headless" ]');
    expect(md).toContain('gstack-first-task-detect');
  });

  test('emits the unified first-run guidance section branching on ACTIVATED', () => {
    expect(md).toContain('## First-run guidance (one-time)');
    expect(md).toContain('`ACTIVATED` is `no`'); // P4 scaffold branch
    expect(md).toContain('`ACTIVATED` is `yes` AND `FIRST_LOOP_SHOWN` is `no`'); // P3 tip branch
  });

  test('marks activated + logs the scaffold telemetry only on the shown path', () => {
    expect(md).toContain('first_task_scaffold_shown');
    expect(md).toContain('touch ~/.gstack/.activated');
    expect(md).toContain('touch ~/.gstack/.first-loop-tip-shown');
  });
});
