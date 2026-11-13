/**
 * #2516: the brain worktree gbrain indexes must advance on the daily sync —
 * and the unattended advance path must be SAFE: refuse dirty worktrees,
 * refuse anything that is not a worktree of the artifacts repo, and never
 * force-remove. (Pre-fix, the worktree only moved when setup-gbrain /
 * sync-gbrain / brain-restore ran, so brains silently served stale pages.)
 */
import { describe, test as _test, expect, beforeEach, afterEach } from 'bun:test';
const test = (name: string, fn: any) => _test(name, fn, 30000);
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawnSync } from 'child_process';

const ROOT = path.resolve(import.meta.dir, '..');
const BIN = path.join(ROOT, 'bin');

let tmpHome: string;

function run(argv: string[], env: Record<string, string> = {}) {
  const full = path.join(BIN, argv[0]);
  const res = spawnSync(full, argv.slice(1), {
    env: { ...process.env, HOME: tmpHome, GSTACK_HOME: tmpHome, ...env },
    encoding: 'utf-8',
    cwd: ROOT,
    timeout: 30_000,
  });
  return { stdout: res.stdout || '', stderr: res.stderr || '', status: res.status ?? -1 };
}

function git(args: string[], cwd: string) {
  const res = spawnSync('git', args, { cwd, encoding: 'utf-8', timeout: 30_000 });
  return { stdout: (res.stdout || '').trim(), status: res.status ?? -1 };
}

function commit(cwd: string, msg: string): string {
  fs.appendFileSync(path.join(cwd, 'artifact.md'), `${msg}\n`);
  git(['add', 'artifact.md'], cwd);
  git(['commit', '-q', '-m', msg], cwd);
  return git(['rev-parse', 'HEAD'], cwd).stdout;
}

const worktreePath = () => path.join(tmpHome, '.gstack-brain-worktree');

function makeArtifactsRepoWithWorktree(): { head: string } {
  git(['init', '-q', '-b', 'main'], tmpHome);
  git(['config', 'user.email', 't@t'], tmpHome);
  git(['config', 'user.name', 't'], tmpHome);
  const head = commit(tmpHome, 'seed');
  git(['worktree', 'add', '--detach', worktreePath(), head], tmpHome);
  return { head };
}

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'wtree-adv-home-'));
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe('gstack-gbrain-source-wireup --advance-only (#2516)', () => {
  test('advances a clean, behind worktree to the parent HEAD', () => {
    makeArtifactsRepoWithWorktree();
    const newHead = commit(tmpHome, 'second');
    const r = run(['gstack-gbrain-source-wireup', '--advance-only']);
    expect(r.status).toBe(0);
    expect(r.stdout + r.stderr).toContain('advanced');
    expect(git(['rev-parse', 'HEAD'], worktreePath()).stdout).toBe(newHead);
  });

  test('up-to-date worktree is a no-op', () => {
    const { head } = makeArtifactsRepoWithWorktree();
    const r = run(['gstack-gbrain-source-wireup', '--advance-only']);
    expect(r.status).toBe(0);
    expect(r.stdout + r.stderr).toContain('up-to-date');
    expect(git(['rev-parse', 'HEAD'], worktreePath()).stdout).toBe(head);
  });

  test('REFUSES a dirty worktree — local changes are never advanced away', () => {
    const { head } = makeArtifactsRepoWithWorktree();
    commit(tmpHome, 'second');
    fs.writeFileSync(path.join(worktreePath(), 'artifact.md'), 'local edit\n');
    const r = run(['gstack-gbrain-source-wireup', '--advance-only']);
    expect(r.status).toBe(0); // benign skip, not a hard failure
    expect(r.stderr).toContain('local changes');
    expect(git(['rev-parse', 'HEAD'], worktreePath()).stdout).toBe(head); // untouched
    expect(fs.readFileSync(path.join(worktreePath(), 'artifact.md'), 'utf-8')).toBe('local edit\n');
  });

  test('REFUSES a path that is not a worktree of the artifacts repo', () => {
    makeArtifactsRepoWithWorktree();
    // A standalone user repo masquerading as the brain worktree.
    const userRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'wtree-adv-user-'));
    try {
      git(['init', '-q', '-b', 'main'], userRepo);
      git(['config', 'user.email', 't@t'], userRepo);
      git(['config', 'user.name', 't'], userRepo);
      const userHead = commit(userRepo, 'user work');
      const r = run(['gstack-gbrain-source-wireup', '--advance-only'], {
        GSTACK_BRAIN_WORKTREE: userRepo,
      });
      expect(r.status).toBe(0);
      expect(r.stderr).toContain('not a worktree of');
      expect(git(['rev-parse', 'HEAD'], userRepo).stdout).toBe(userHead); // untouched
    } finally {
      fs.rmSync(userRepo, { recursive: true, force: true });
    }
  });

  test('missing worktree is a benign skip', () => {
    git(['init', '-q', '-b', 'main'], tmpHome);
    git(['config', 'user.email', 't@t'], tmpHome);
    git(['config', 'user.name', 't'], tmpHome);
    commit(tmpHome, 'seed');
    const r = run(['gstack-gbrain-source-wireup', '--advance-only']);
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('no managed worktree');
  });

  test('never contains a force-remove on the advance-only path (static pin)', () => {
    // The unattended path must not be able to delete local worktree changes:
    // do_advance_only may not call safe_rm_worktree, `worktree remove`, or rm -rf.
    const src = fs.readFileSync(path.join(BIN, 'gstack-gbrain-source-wireup'), 'utf-8');
    const fn = src.slice(src.indexOf('do_advance_only()'), src.indexOf('do_uninstall()'));
    expect(fn.length).toBeGreaterThan(100);
    expect(fn).not.toContain('safe_rm_worktree');
    expect(fn).not.toContain('worktree remove');
    expect(fn).not.toContain('rm -rf');
  });
});

describe('brain-sync --once worktree advance wiring (#2516)', () => {
  const failStamp = () => path.join(tmpHome, '.brain-worktree-advance-failed');
  const wtHead = () => git(['rev-parse', 'HEAD'], worktreePath()).stdout;

  test("a drain that commits advances the worktree to that drain's own commit", () => {
    // The pre-fix advance ran before the commit, so gbrain always indexed
    // the HEAD from before the drain's own artifacts.
    const bareRemote = fs.mkdtempSync(path.join(os.tmpdir(), 'wtree-adv-remote-'));
    try {
      spawnSync('git', ['init', '--bare', '-q', '-b', 'main', bareRemote], { timeout: 30_000 });
      expect(run(['gstack-artifacts-init', '--remote', bareRemote]).status).toBe(0);
      run(['gstack-config', 'set', 'artifacts_sync_mode', 'full']);
      git(['worktree', 'add', '--detach', worktreePath(), 'HEAD'], tmpHome);
      const before = wtHead();

      fs.mkdirSync(path.join(tmpHome, 'projects', 'p'), { recursive: true });
      fs.writeFileSync(path.join(tmpHome, 'projects/p/learnings.jsonl'),
        '{"skill":"x","insight":"y","ts":"2026-01-01T00:00:00Z"}\n');
      run(['gstack-brain-enqueue', 'projects/p/learnings.jsonl']);
      expect(run(['gstack-brain-sync', '--once']).status).toBe(0);

      const parent = git(['rev-parse', 'HEAD'], tmpHome).stdout;
      expect(git(['log', '-1', '--format=%s'], tmpHome).stdout).toMatch(/^sync: 1 file/);
      expect(parent).not.toBe(before);
      expect(wtHead()).toBe(parent);
      expect(fs.existsSync(path.join(worktreePath(), 'projects/p/learnings.jsonl'))).toBe(true);
    } finally {
      fs.rmSync(bareRemote, { recursive: true, force: true });
    }
  });

  test('advances on every run that finds the worktree behind, with no time window', () => {
    makeArtifactsRepoWithWorktree();
    run(['gstack-config', 'set', 'artifacts_sync_mode', 'artifacts-only']);

    const second = commit(tmpHome, 'second');
    expect(run(['gstack-brain-sync', '--once']).status).toBe(0);
    expect(wtHead()).toBe(second);

    const third = commit(tmpHome, 'third');
    expect(run(['gstack-brain-sync', '--once']).status).toBe(0);
    expect(wtHead()).toBe(third);
    expect(fs.existsSync(failStamp())).toBe(false);
  });

  test('a worktree left behind holds retries for 24h, then a successful advance clears the hold', () => {
    const { head } = makeArtifactsRepoWithWorktree();
    run(['gstack-config', 'set', 'artifacts_sync_mode', 'artifacts-only']);
    const second = commit(tmpHome, 'second');
    fs.writeFileSync(path.join(worktreePath(), 'artifact.md'), 'local edit\n');

    // First run: the advance refuses the dirty worktree and records the hold.
    const r1 = run(['gstack-brain-sync', '--once']);
    expect(r1.status).toBe(0);
    expect(r1.stderr).toContain('local changes');
    expect(wtHead()).toBe(head);
    expect(fs.existsSync(failStamp())).toBe(true);

    // Within 24h: no new attempt, so no repeated warning at every skill start.
    const r2 = run(['gstack-brain-sync', '--once']);
    expect(r2.status).toBe(0);
    expect(r2.stderr).not.toContain('local changes');
    expect(wtHead()).toBe(head);

    // The worktree is clean again and the hold has expired: it advances and clears.
    git(['checkout', '--', 'artifact.md'], worktreePath());
    fs.writeFileSync(failStamp(), String(Math.floor(Date.now() / 1000) - 90000));
    expect(run(['gstack-brain-sync', '--once']).status).toBe(0);
    expect(wtHead()).toBe(second);
    expect(fs.existsSync(failStamp())).toBe(false);
  });
});
