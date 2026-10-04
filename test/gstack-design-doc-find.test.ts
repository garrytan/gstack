import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '..');
const BIN = path.join(ROOT, 'bin/gstack-design-doc-find');
const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'design-doc-find-'));
  temps.push(dir);
  const home = path.join(dir, 'home');
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo, timeout: 10_000 });
  const baseEnv = { PATH: process.env.PATH!, HOME: home, GIT_CEILING_DIRECTORIES: dir };
  const write = (file: string, ageSeconds: number) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '# Design\n');
    const t = Date.now() / 1000 - ageSeconds;
    fs.utimesSync(file, t, t);
    return file;
  };
  const find = (env: Record<string, string> = {}, args = ['proj', 'feat-x']) =>
    execFileSync(BIN, args, { cwd: repo, env: { ...baseEnv, ...env }, encoding: 'utf8', timeout: 10_000 }).trim();
  return { dir, home, repo, write, find };
}

describe('gstack-design-doc-find', () => {
  test('default root is ~/.gstack and prints nothing when no doc exists', () => {
    const f = fixture();
    expect(f.find()).toBe('');
    const doc = f.write(path.join(f.home, '.gstack/projects/proj/user-main-design-20260101.md'), 100);
    expect(f.find()).toBe(doc);
  });

  test('GSTACK_HOME moves the state root', () => {
    const f = fixture();
    f.write(path.join(f.home, '.gstack/projects/proj/user-main-design-a.md'), 10);
    const custom = path.join(f.dir, 'custom-state');
    const doc = f.write(path.join(custom, 'projects/proj/user-main-design-b.md'), 100);
    expect(f.find({ GSTACK_HOME: custom })).toBe(doc);
  });

  test('a branch-specific doc wins over a newer generic doc', () => {
    const f = fixture();
    const branch = f.write(path.join(f.home, '.gstack/projects/proj/user-feat-x-design-1.md'), 500);
    f.write(path.join(f.home, '.gstack/projects/proj/user-main-design-2.md'), 10);
    expect(f.find()).toBe(branch);
    expect(f.find({}, ['proj', 'other'])).toBe(path.join(f.home, '.gstack/projects/proj/user-main-design-2.md'));
  });

  test('a repo docs/designs doc wins only when at least as fresh; a root DESIGN.md never does (#2839)', () => {
    const f = fixture();
    const local = f.write(path.join(f.home, '.gstack/projects/proj/user-feat-x-design-1.md'), 100);
    const designs = f.write(path.join(f.repo, 'docs/designs/plan.md'), 10);
    expect(f.find()).toBe(designs);
    fs.utimesSync(designs, Date.now() / 1000 - 1000, Date.now() / 1000 - 1000);
    expect(f.find()).toBe(local);
    const top = f.write(path.join(f.repo, 'DESIGN.md'), 0);
    expect(f.find()).toBe(local);
    fs.rmSync(local);
    expect(f.find()).toBe(designs);
    fs.rmSync(designs);
    expect(top).toBe(path.join(f.repo, 'DESIGN.md'));
    expect(f.find()).toBe('');
  });

  test('a repo doc is used when the state root has none', () => {
    const f = fixture();
    const designs = f.write(path.join(f.repo, 'docs/designs/plan.md'), 1000);
    expect(f.find()).toBe(designs);
  });

  test('usage errors exit 2', () => {
    const f = fixture();
    expect(() => f.find({}, [])).toThrow();
  });
});

describe('rendered Design Doc Check block', () => {
  const rendered = fs.readFileSync(path.join(ROOT, 'plan-ceo-review/SKILL.md'), 'utf8');
  const block = rendered.slice(rendered.indexOf('DESIGN=$(~/.claude/skills/gstack/bin/gstack-design-doc-find'))
    .split('\n').slice(0, 2).join('\n');

  test('the generated skill renders one helper invocation', () => {
    expect(block).toContain('gstack-design-doc-find "$SLUG" "$BRANCH"');
    expect(block).toContain('echo "Design doc found: $DESIGN"');
    expect(block).toContain('echo "No design doc found"');
  });

  test('finds an office-hours doc under a custom GSTACK_HOME and keeps the default-root result', () => {
    const f = fixture();
    const installed = path.join(f.home, '.claude/skills/gstack/bin');
    fs.mkdirSync(installed, { recursive: true });
    for (const bin of ['gstack-design-doc-find', 'gstack-paths', 'gstack-state-root.sh']) {
      fs.copyFileSync(path.join(ROOT, 'bin', bin), path.join(installed, bin));
      fs.chmodSync(path.join(installed, bin), 0o755);
    }
    const run = (env: Record<string, string>) => execFileSync('bash', ['-c', `SLUG=proj; BRANCH=main; ${block}`],
      { cwd: f.repo, env: { PATH: process.env.PATH!, HOME: f.home, GIT_CEILING_DIRECTORIES: f.dir, ...env }, encoding: 'utf8', timeout: 10_000 }).trim();
    const custom = path.join(f.dir, 'custom-state');
    const doc = f.write(path.join(custom, 'projects/proj/garry-main-design-20261003-120000.md'), 60);
    expect(run({ GSTACK_HOME: custom })).toBe(`Design doc found: ${doc}`);
    expect(run({})).toBe('No design doc found');
    const legacy = f.write(path.join(f.home, '.gstack/projects/proj/garry-main-design-20261001-120000.md'), 60);
    expect(run({})).toBe(`Design doc found: ${legacy}`);
  });
});
