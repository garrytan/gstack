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

describe('first-run-guidance wiring (bin/gstack-skill-start emission layer)', () => {
  // Token-reduction Phase 2: the first-run guidance left the rendered
  // preamble entirely. The gate, the token→tip case-map, the marker touches,
  // and the scaffold telemetry all live in bin/gstack-skill-start; the tips
  // reach the model as GSTACK_INSTRUCTION blocks emitted only when the gate
  // fires. Tip TEXT + absence-from-renders are pinned by
  // test/onboarding-moved-literals.test.ts (tombstone) — this suite pins the
  // gating structure and the enum→tip map coverage.
  const script = fs.readFileSync(path.join(ROOT, 'bin', 'gstack-skill-start'), 'utf-8');

  test('detection is gated to the first-ever run only (ACTIVATED=no, not headless)', () => {
    expect(script).toContain('if [ "$_ACTIVATED" = "no" ] && [ "$_SESSION_KIND" != "headless" ]');
    expect(script).toContain('gstack-first-task-detect');
    // The result is still echoed as a STATUS line (sanitized passthrough).
    expect(script).toContain("printf 'FIRST_TASK: %s\\n' \"$_FIRST_TASK\"");
  });

  test('emission layer branches on ACTIVATED then FIRST_LOOP_SHOWN', () => {
    // P4 scaffold branch (first-ever run) …
    expect(script).toContain('if [ "$_ACTIVATED" = "no" ]; then');
    expect(script).toContain('_emit_block first-run-tip');
    // … then the P3 loop tip fires exactly once on a later run.
    expect(script).toContain('elif [ "$_FIRST_LOOP_SHOWN" = "no" ]; then');
    expect(script).toContain('_emit_block first-loop-tip');
  });

  test('token→tip case-map covers every tip-bearing enum bucket (nongit excluded)', () => {
    // The detector's whole enum must map to a tip (nongit intentionally maps
    // to no tip — no block emits, but activation is still marked). A bucket
    // added to the detector without a case arm would silently show nothing.
    const caseStart = script.indexOf('case "$_FIRST_TASK" in');
    expect(caseStart).toBeGreaterThan(0);
    const caseBody = script.slice(caseStart, script.indexOf('esac', caseStart));
    for (const token of ENUM) {
      if (token === 'nongit') continue;
      expect(caseBody, `case-map missing enum bucket: ${token}`).toContain(token);
    }
    expect(caseBody).not.toContain('nongit');
  });

  test('script marks activated + logs scaffold telemetry AT EMIT (display-only tips)', () => {
    // Phase 2 OV6: the model no longer runs these — the script does, when it
    // emits the block. Telemetry fires only on the shown path (a tip was
    // actually emitted); activation is marked regardless so detection never
    // re-fires.
    expect(script).toMatch(
      /if \[ -n "\$_FT_TIP" \]; then\n\s*_emit_block first-run-tip[\s\S]*?first_task_scaffold_shown[\s\S]*?fi\n\s*touch "\$_GH\/\.activated"/,
    );
    expect(script).toMatch(/_emit_block first-loop-tip[\s\S]{0,500}?touch "\$_GH\/\.first-loop-tip-shown"/);
    // Telemetry is scoped INSIDE the shown path, not the outer branch.
    const branch = script.slice(
      script.indexOf('if [ "$_ACTIVATED" = "no" ]; then'),
      script.indexOf('touch "$_GH/.activated"'),
    );
    expect(branch).toContain('--event-type first_task_scaffold_shown');
  });
});
