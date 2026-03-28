/**
 * Unit tests for WorktreeManager.
 *
 * Tests worktree lifecycle: create, harvest, dedup, cleanup, prune.
 * Each test creates real git worktrees in a temporary repo.
 */

import { describe, test, expect, afterEach } from 'bun:test';
import { WorktreeManager } from '../lib/worktree';
import type { HarvestResult } from '../lib/worktree';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

/** Create a minimal git repo in a tmpdir for testing. */
function createTestRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'worktree-test-'));
  spawnSync('git', ['init'], { cwd: dir, stdio: 'pipe' });
  spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: dir, stdio: 'pipe' });
  spawnSync('git', ['config', 'user.name', 'Test'], { cwd: dir, stdio: 'pipe' });

  // Create initial commit so HEAD exists
  fs.writeFileSync(path.join(dir, 'README.md'), '# Test repo\n');
  // Add .gitignore matching real repo (so copied build artifacts don't appear as changes)
  fs.writeFileSync(path.join(dir, '.gitignore'), '.agents/\nbrowse/dist/\n.gstack-worktrees/\n');
  // Create a .agents directory (simulating gitignored build artifacts)
  fs.mkdirSync(path.join(dir, '.agents', 'skills'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.agents', 'skills', 'test-skill.md'), '# Test skill\n');
  // Create browse/dist (simulating build artifacts)
  fs.mkdirSync(path.join(dir, 'browse', 'dist'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'browse', 'dist', 'browse'), '#!/bin/sh\necho browse\n');

  spawnSync('git', ['add', 'README.md', '.gitignore'], { cwd: dir, stdio: 'pipe' });
  spawnSync('git', ['commit', '-m', 'Initial commit'], { cwd: dir, stdio: 'pipe' });

  return dir;
}

/** Clean up a test repo. */
function cleanupRepo(dir: string): void {
  // Prune worktrees first to avoid git lock issues
  spawnSync('git', ['worktree', 'prune'], { cwd: dir, stdio: 'pipe' });
  fs.rmSync(dir, { recursive: true, force: true });
}

// Track repos to clean up
const repos: string[] = [];

// Dedup index path — clear before each test to avoid cross-run contamination
const DEDUP_PATH = path.join(os.homedir(), '.gstack-dev', 'harvests', 'dedup.json');

afterEach(() => {
  for (const repo of repos) {
    try { cleanupRepo(repo); } catch { /* best effort */ }
  }
  repos.length = 0;
  // Clear dedup index so tests are independent
  try { fs.unlinkSync(DEDUP_PATH); } catch { /* may not exist */ }
});

describe('WorktreeManager', () => {

  test('create() produces a valid worktree at the expected path', () => {
    const repo = createTestRepo();
    repos.push(repo);
    const mgr = new WorktreeManager(repo);

    const worktreePath = mgr.create('test-1');

    expect(fs.existsSync(worktreePath)).toBe(true);
    expect(fs.existsSync(path.join(worktreePath, 'README.md'))).toBe(true);
    expect(worktreePath).toContain('.gstack-worktrees');
    expect(worktreePath).toContain('test-1');

    mgr.cleanup('test-1');
  });

  test('create() worktree has .agents/skills/ (gitignored artifacts copied)', () => {
    const repo = createTestRepo();
    repos.push(repo);
    const mgr = new WorktreeManager(repo);

    const worktreePath = mgr.create('test-agents');

    expect(fs.existsSync(path.join(worktreePath, '.agents', 'skills', 'test-skill.md'))).toBe(true);
    expect(fs.existsSync(path.join(worktreePath, 'browse', 'dist', 'browse'))).toBe(true);

    mgr.cleanup('test-agents');
  });

  test('create() stores correct originalSha', () => {
    const repo = createTestRepo();
    repos.push(repo);
    const mgr = new WorktreeManager(repo);

    const expectedSha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, stdio: 'pipe' })
      .stdout.toString().trim();

    mgr.create('test-sha');

    const info = mgr.getInfo('test-sha');
    expect(info).toBeDefined();
    expect(info!.originalSha).toBe(expectedSha);

    mgr.cleanup('test-sha');
  });

  test('harvest() captures modifications to tracked files', () => {
    const repo = createTestRepo();
    repos.push(repo);
    const mgr = new WorktreeManager(repo);

    const worktreePath = mgr.create('test-harvest-mod');

    // Modify a tracked file in the worktree
    fs.writeFileSync(path.join(worktreePath, 'README.md'), '# Modified!\n');

    const result = mgr.harvest('test-harvest-mod');

    expect(result).not.toBeNull();
    expect(result!.changedFiles).toContain('README.md');
    expect(result!.isDuplicate).toBe(false);
    expect(result!.patchPath).toBeTruthy();
    expect(fs.existsSync(result!.patchPath)).toBe(true);

    mgr.cleanup('test-harvest-mod');
  });

  test('harvest() captures new untracked files (git add -A path)', () => {
    const repo = createTestRepo();
    repos.push(repo);
    const mgr = new WorktreeManager(repo);

    const worktreePath = mgr.create('test-harvest-new');

    // Create a new file in the worktree
    fs.writeFileSync(path.join(worktreePath, 'new-file.txt'), 'Hello from agent\n');

    const result = mgr.harvest('test-harvest-new');

    expect(result).not.toBeNull();
    expect(result!.changedFiles).toContain('new-file.txt');

    mgr.cleanup('test-harvest-new');
  });

  test('harvest() captures committed changes (git diff originalSha)', () => {
    const repo = createTestRepo();
    repos.push(repo);
    const mgr = new WorktreeManager(repo);

    const worktreePath = mgr.create('test-harvest-commit');

    // Make a commit in the worktree (simulating agent running git commit)
    fs.writeFileSync(path.join(worktreePath, 'committed.txt'), 'Agent committed this\n');
    spawnSync('git', ['add', 'committed.txt'], { cwd: worktreePath, stdio: 'pipe' });
    spawnSync('git', ['commit', '-m', 'Agent commit'], { cwd: worktreePath, stdio: 'pipe' });

    const result = mgr.harvest('test-harvest-commit');

    expect(result).not.toBeNull();
    expect(result!.changedFiles).toContain('committed.txt');

    mgr.cleanup('test-harvest-commit');
  });

  test('harvest() returns null when worktree is clean', () => {
    const repo = createTestRepo();
    repos.push(repo);
    const mgr = new WorktreeManager(repo);

    mgr.create('test-harvest-clean');

    // Don't modify anything
    const result = mgr.harvest('test-harvest-clean');

    expect(result).toBeNull();

    mgr.cleanup('test-harvest-clean');
  });

  test('harvest() dedup skips identical patches', () => {
    const repo = createTestRepo();
    repos.push(repo);

    // First run
    const mgr1 = new WorktreeManager(repo);
    const wt1 = mgr1.create('test-dedup-1');
    fs.writeFileSync(path.join(wt1, 'dedup-test.txt'), 'same content\n');
    const result1 = mgr1.harvest('test-dedup-1');
    mgr1.cleanup('test-dedup-1');

    expect(result1).not.toBeNull();
    expect(result1!.isDuplicate).toBe(false);

    // Second run with same change
    const mgr2 = new WorktreeManager(repo);
    const wt2 = mgr2.create('test-dedup-2');
    fs.writeFileSync(path.join(wt2, 'dedup-test.txt'), 'same content\n');
    const result2 = mgr2.harvest('test-dedup-2');
    mgr2.cleanup('test-dedup-2');

    expect(result2).not.toBeNull();
    expect(result2!.isDuplicate).toBe(true);
  });

  test('cleanup() removes worktree directory', () => {
    const repo = createTestRepo();
    repos.push(repo);
    const mgr = new WorktreeManager(repo);

    const worktreePath = mgr.create('test-cleanup');
    expect(fs.existsSync(worktreePath)).toBe(true);

    mgr.cleanup('test-cleanup');
    expect(fs.existsSync(worktreePath)).toBe(false);
  });

  test('pruneStale() removes orphaned worktrees from previous runs', () => {
    const repo = createTestRepo();
    repos.push(repo);

    // Create a worktree with a different manager (simulating a previous run)
    const oldMgr = new WorktreeManager(repo);
    const oldPath = oldMgr.create('stale-test');
    const oldRunDir = path.dirname(oldPath);
    expect(fs.existsSync(oldPath)).toBe(true);

    // Remove via git but leave directory (simulating a crash)
    spawnSync('git', ['worktree', 'remove', '--force', oldPath], { cwd: repo, stdio: 'pipe' });
    // Recreate the directory to simulate orphaned state
    fs.mkdirSync(oldPath, { recursive: true });

    // New manager should prune the old run's directory
    const newMgr = new WorktreeManager(repo);
    newMgr.pruneStale();

    expect(fs.existsSync(oldRunDir)).toBe(false);
  });

  test('create() throws on failure (no silent fallback to ROOT)', () => {
    const repo = createTestRepo();
    repos.push(repo);
    const mgr = new WorktreeManager(repo);

    // Create the same worktree twice — second should fail because path exists
    mgr.create('test-fail');
    expect(() => mgr.create('test-fail')).toThrow();

    mgr.cleanup('test-fail');
  });

  test('harvest() returns null gracefully when worktree dir was deleted by agent', () => {
    const repo = createTestRepo();
    repos.push(repo);
    const mgr = new WorktreeManager(repo);

    const worktreePath = mgr.create('test-deleted');

    // Simulate agent deleting its own worktree directory
    fs.rmSync(worktreePath, { recursive: true, force: true });

    // harvest should return null gracefully, not throw
    const result = mgr.harvest('test-deleted');
    expect(result).toBeNull();

    // cleanup should also be non-fatal
    mgr.cleanup('test-deleted');
  });
});
