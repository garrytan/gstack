import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { checkWorkingTreeClean, findUnshippedFeatBranches } from '../cli';

describe('checkWorkingTreeClean', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'startup-clean-'));
    spawnSync('git', ['init', '--initial-branch=main'], { cwd: tempDir });
    // Fallback for git < 2.28 that ignores --initial-branch.
    spawnSync('git', ['checkout', '-B', 'main'], { cwd: tempDir });
    spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: tempDir });
    spawnSync('git', ['config', 'user.name', 'Test'], { cwd: tempDir });
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('clean repo → { clean: true, dirty: [] }', () => {
    fs.writeFileSync(path.join(tempDir, 'README.md'), 'init');
    spawnSync('git', ['add', '.'], { cwd: tempDir });
    spawnSync('git', ['commit', '-m', 'init'], { cwd: tempDir });

    expect(checkWorkingTreeClean(tempDir)).toEqual({ clean: true, dirty: [] });
  });

  it('repo with a modified tracked file → { clean: false }, dirty array contains the status line', () => {
    fs.writeFileSync(path.join(tempDir, 'README.md'), 'init');
    spawnSync('git', ['add', '.'], { cwd: tempDir });
    spawnSync('git', ['commit', '-m', 'init'], { cwd: tempDir });

    fs.writeFileSync(path.join(tempDir, 'README.md'), 'mod');

    const result = checkWorkingTreeClean(tempDir);
    expect(result.clean).toBe(false);
    expect(result.dirty.length).toBeGreaterThan(0);
    expect(result.dirty[0]).toMatch(/M README\.md/);
  });

  it('repo with ONLY an untracked file (not git added) → { clean: true }', () => {
    fs.writeFileSync(path.join(tempDir, 'README.md'), 'init');
    spawnSync('git', ['add', '.'], { cwd: tempDir });
    spawnSync('git', ['commit', '-m', 'init'], { cwd: tempDir });

    fs.writeFileSync(path.join(tempDir, 'untracked.ts'), 'untracked');

    expect(checkWorkingTreeClean(tempDir)).toEqual({ clean: true, dirty: [] });
  });

  it('repo with a staged (git add) file → { clean: false }', () => {
    fs.writeFileSync(path.join(tempDir, 'README.md'), 'init');
    spawnSync('git', ['add', '.'], { cwd: tempDir });
    spawnSync('git', ['commit', '-m', 'init'], { cwd: tempDir });

    fs.writeFileSync(path.join(tempDir, 'staged.ts'), 'staged');
    spawnSync('git', ['add', 'staged.ts'], { cwd: tempDir });

    const result = checkWorkingTreeClean(tempDir);
    expect(result.clean).toBe(false);
    expect(result.dirty).toHaveLength(1);
    expect(result.dirty[0]).toMatch(/A\s+staged\.ts/);
  });
});

describe('findUnshippedFeatBranches', () => {
  let mainDir: string;
  let bareDir: string;

  beforeEach(() => {
    mainDir = fs.mkdtempSync(path.join(os.tmpdir(), 'startup-main-'));
    bareDir = fs.mkdtempSync(path.join(os.tmpdir(), 'startup-bare-'));
    spawnSync('git', ['init', '--initial-branch=main'], { cwd: mainDir });
    // Fallback for git < 2.28 that ignores --initial-branch.
    spawnSync('git', ['checkout', '-B', 'main'], { cwd: mainDir });
    spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: mainDir });
    spawnSync('git', ['config', 'user.name', 'Test'], { cwd: mainDir });
    spawnSync('git', ['init', '--bare', '--initial-branch=main'], { cwd: bareDir });
    // Fallback for git < 2.28 that ignores --initial-branch in bare repos.
    spawnSync('git', ['symbolic-ref', 'HEAD', 'refs/heads/main'], { cwd: bareDir });
    spawnSync('git', ['remote', 'add', 'origin', bareDir], { cwd: mainDir });
    // make a commit so main exists
    fs.writeFileSync(path.join(mainDir, 'README.md'), 'init');
    spawnSync('git', ['add', '.'], { cwd: mainDir });
    spawnSync('git', ['commit', '-m', 'init'], { cwd: mainDir });
    spawnSync('git', ['push', '-u', 'origin', 'main'], { cwd: mainDir });
  });

  afterEach(() => {
    fs.rmSync(mainDir, { recursive: true, force: true });
    fs.rmSync(bareDir, { recursive: true, force: true });
  });

  it('remote has origin/feat/a (not merged to main) → returns ["feat/a"]', () => {
    spawnSync('git', ['checkout', '-b', 'feat/a'], { cwd: mainDir });
    fs.writeFileSync(path.join(mainDir, 'feat-a.ts'), 'feat a');
    spawnSync('git', ['add', '.'], { cwd: mainDir });
    spawnSync('git', ['commit', '-m', 'feat a'], { cwd: mainDir });
    spawnSync('git', ['push', 'origin', 'feat/a'], { cwd: mainDir });
    spawnSync('git', ['checkout', 'main'], { cwd: mainDir });

    const result = findUnshippedFeatBranches(mainDir, 'main');
    expect(result).toEqual(['feat/a']);
  });

  it('remote has origin/feat/b (merged to main) → returns []', () => {
    spawnSync('git', ['checkout', '-b', 'feat/b'], { cwd: mainDir });
    fs.writeFileSync(path.join(mainDir, 'feat-b.ts'), 'feat b');
    spawnSync('git', ['add', '.'], { cwd: mainDir });
    spawnSync('git', ['commit', '-m', 'feat b'], { cwd: mainDir });
    spawnSync('git', ['push', 'origin', 'feat/b'], { cwd: mainDir });
    spawnSync('git', ['checkout', 'main'], { cwd: mainDir });
    spawnSync('git', ['merge', '--no-ff', 'feat/b', '-m', 'merge feat/b'], { cwd: mainDir });
    spawnSync('git', ['push', 'origin', 'main'], { cwd: mainDir });

    const result = findUnshippedFeatBranches(mainDir, 'main');
    expect(result).toEqual([]);
  });

  it('current branch is feat/a (even if unmerged) → excluded from results (returns [])', () => {
    spawnSync('git', ['checkout', '-b', 'feat/a'], { cwd: mainDir });
    fs.writeFileSync(path.join(mainDir, 'feat-a.ts'), 'feat a');
    spawnSync('git', ['add', '.'], { cwd: mainDir });
    spawnSync('git', ['commit', '-m', 'feat a'], { cwd: mainDir });
    spawnSync('git', ['push', 'origin', 'feat/a'], { cwd: mainDir });

    // We stay on feat/a
    const result = findUnshippedFeatBranches(mainDir, 'feat/a');
    expect(result).toEqual([]);
  });

  it('no feat/* branches on origin → returns []', () => {
    const result = findUnshippedFeatBranches(mainDir, 'main');
    expect(result).toEqual([]);
  });
});
