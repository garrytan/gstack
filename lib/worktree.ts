/**
 * Git worktree manager for isolated test execution with change harvesting.
 *
 * Creates git worktrees for test suites that need real repo context,
 * harvests any changes the test agent makes as patches, and provides
 * deduplication across runs.
 *
 * Reusable platform module — future /batch or /codex challenge skills
 * can import this directly.
 */

import { spawnSync } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// --- Interfaces ---

export interface WorktreeInfo {
  path: string;
  testName: string;
  originalSha: string;
  createdAt: number;
}

export interface HarvestResult {
  testName: string;
  worktreePath: string;
  diffStat: string;
  patchPath: string;
  changedFiles: string[];
  isDuplicate: boolean;
}

// --- Utility ---

/** Recursive directory copy (pure TypeScript, no external deps). */
function copyDirSync(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    // Skip symlinks to avoid infinite recursion (e.g., .claude/skills/gstack → repo root)
    if (entry.isSymbolicLink()) continue;
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

/** Run a git command and return stdout. Throws on failure unless tolerateFailure is set. */
function git(args: string[], cwd: string, tolerateFailure = false): string {
  const result = spawnSync('git', args, { cwd, stdio: 'pipe', timeout: 30_000 });
  const stdout = result.stdout?.toString().trim() ?? '';
  const stderr = result.stderr?.toString().trim() ?? '';
  if (result.status !== 0 && !tolerateFailure) {
    throw new Error(`git ${args.join(' ')} failed (exit ${result.status}): ${stderr || stdout}`);
  }
  return stdout;
}

// --- Dedup index ---

interface DedupIndex {
  hashes: Record<string, string>; // hash → first-seen runId
}

function getDedupPath(): string {
  return path.join(os.homedir(), '.gstack-dev', 'harvests', 'dedup.json');
}

function loadDedupIndex(): DedupIndex {
  try {
    const raw = fs.readFileSync(getDedupPath(), 'utf-8');
    return JSON.parse(raw);
  } catch {
    return { hashes: {} };
  }
}

function saveDedupIndex(index: DedupIndex): void {
  const dir = path.dirname(getDedupPath());
  fs.mkdirSync(dir, { recursive: true });
  const tmp = getDedupPath() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(index, null, 2));
  fs.renameSync(tmp, getDedupPath());
}

// --- WorktreeManager ---

export class WorktreeManager {
  private repoRoot: string;
  private runId: string;
  private active: Map<string, WorktreeInfo> = new Map();
  private harvestResults: HarvestResult[] = [];

  constructor(repoRoot?: string) {
    if (repoRoot) {
      this.repoRoot = repoRoot;
    } else {
      this.repoRoot = git(['rev-parse', '--show-toplevel'], process.cwd());
    }
    this.runId = crypto.randomUUID();

    // Register cleanup on process exit
    process.on('exit', () => {
      this.cleanupAll();
    });
  }

  /** Create an isolated worktree. Returns the worktree path. Throws on failure. */
  create(testName: string): string {
    const originalSha = git(['rev-parse', 'HEAD'], this.repoRoot);

    const worktreeBase = path.join(this.repoRoot, '.gstack-worktrees', this.runId);
    fs.mkdirSync(worktreeBase, { recursive: true });

    const worktreePath = path.join(worktreeBase, testName);

    // Create detached worktree at current HEAD
    git(['worktree', 'add', '--detach', worktreePath, 'HEAD'], this.repoRoot);

    // Copy gitignored build artifacts that tests need (config-driven)
    const { getExternalHosts } = require('../hosts/index');
    for (const hostConfig of getExternalHosts()) {
      const hostSrc = path.join(this.repoRoot, hostConfig.hostSubdir);
      if (fs.existsSync(hostSrc)) {
        copyDirSync(hostSrc, path.join(worktreePath, hostConfig.hostSubdir));
      }
    }

    const browseDist = path.join(this.repoRoot, 'browse', 'dist');
    if (fs.existsSync(browseDist)) {
      copyDirSync(browseDist, path.join(worktreePath, 'browse', 'dist'));
    }

    const info: WorktreeInfo = {
      path: worktreePath,
      testName,
      originalSha,
      createdAt: Date.now(),
    };
    this.active.set(testName, info);

    return worktreePath;
  }

  /** Harvest changes from a worktree. Returns null if clean or on error. */
  harvest(testName: string): HarvestResult | null {
    const info = this.active.get(testName);
    if (!info) return null;

    try {
      // Check if worktree directory still exists (agent may have deleted it)
      if (!fs.existsSync(info.path)) {
        process.stderr.write(`  HARVEST [${testName}]: worktree dir deleted, skipping\n`);
        return null;
      }

      // Stage everything including untracked files
      git(['-C', info.path, 'add', '-A'], info.path, true);

      // Get diff against original SHA (captures both committed and uncommitted changes)
      const patch = git(['-C', info.path, 'diff', info.originalSha, '--cached'], info.path, true);

      if (!patch) return null;

      // Get diff stat for human-readable output
      const diffStat = git(['-C', info.path, 'diff', info.originalSha, '--cached', '--stat'], info.path, true);

      // Get changed file names
      const nameOnly = git(['-C', info.path, 'diff', info.originalSha, '--cached', '--name-only'], info.path, true);
      const changedFiles = nameOnly.split('\n').filter(Boolean);

      // Dedup check
      const hash = crypto.createHash('sha256').update(patch).digest('hex');
      const dedupIndex = loadDedupIndex();
      const isDuplicate = hash in dedupIndex.hashes;

      let patchPath = '';

      if (!isDuplicate) {
        // Save patch
        const harvestDir = path.join(os.homedir(), '.gstack-dev', 'harvests', this.runId);
        fs.mkdirSync(harvestDir, { recursive: true });
        patchPath = path.join(harvestDir, `${testName}.patch`);
        fs.writeFileSync(patchPath, patch);

        // Update dedup index
        dedupIndex.hashes[hash] = this.runId;
        saveDedupIndex(dedupIndex);
      }

      const result: HarvestResult = {
        testName,
        worktreePath: info.path,
        diffStat,
        patchPath,
        changedFiles,
        isDuplicate,
      };

      this.harvestResults.push(result);
      return result;
    } catch (err) {
      process.stderr.write(`  HARVEST [${testName}]: error — ${err}\n`);
      return null;
    }
  }

  /** Remove a worktree. Non-fatal on error. */
  cleanup(testName: string): void {
    const info = this.active.get(testName);
    if (!info) return;

    try {
      git(['worktree', 'remove', '--force', info.path], this.repoRoot, true);
    } catch {
      // Force remove the directory if git worktree remove fails
      try {
        fs.rmSync(info.path, { recursive: true, force: true });
        git(['worktree', 'prune'], this.repoRoot, true);
      } catch { /* non-fatal */ }
    }

    this.active.delete(testName);
  }

  /** Force-remove all active worktrees (for process exit handler). */
  cleanupAll(): void {
    for (const testName of [...this.active.keys()]) {
      this.cleanup(testName);
    }

    // Clean up the run directory if empty
    const runDir = path.join(this.repoRoot, '.gstack-worktrees', this.runId);
    try {
      const entries = fs.readdirSync(runDir);
      if (entries.length === 0) {
        fs.rmdirSync(runDir);
      }
    } catch { /* non-fatal */ }
  }

  /** Remove worktrees from previous runs that weren't cleaned up. */
  pruneStale(): void {
    try {
      git(['worktree', 'prune'], this.repoRoot, true);

      const worktreeBase = path.join(this.repoRoot, '.gstack-worktrees');
      if (!fs.existsSync(worktreeBase)) return;

      for (const entry of fs.readdirSync(worktreeBase)) {
        // Don't prune our own run
        if (entry === this.runId) continue;

        const entryPath = path.join(worktreeBase, entry);
        try {
          // Skip recent worktrees (< 1 hour old) to avoid killing
          // worktrees from concurrent test runs still in progress
          const stat = fs.statSync(entryPath);
          const ageMs = Date.now() - stat.mtimeMs;
          if (ageMs < 3600_000) continue;
          fs.rmSync(entryPath, { recursive: true, force: true });
        } catch { /* non-fatal */ }
      }
    } catch {
      process.stderr.write('  WORKTREE: prune failed (non-fatal)\n');
    }
  }

  /** Print harvest report summary. */
  printReport(): void {
    if (this.harvestResults.length === 0) return;

    const nonDuplicates = this.harvestResults.filter(r => !r.isDuplicate);
    process.stderr.write('\n=== HARVEST REPORT ===\n');
    process.stderr.write(`${nonDuplicates.length} of ${this.harvestResults.length} test suites produced new changes:\n\n`);

    for (const result of this.harvestResults) {
      if (result.isDuplicate) {
        process.stderr.write(`  ${result.testName}: duplicate patch (skipped)\n`);
      } else {
        process.stderr.write(`  ${result.testName}: ${result.changedFiles.length} files changed\n`);
        process.stderr.write(`    Patch: ${result.patchPath}\n`);
        process.stderr.write(`    Apply: git apply ${result.patchPath}\n`);
        if (result.diffStat) {
          process.stderr.write(`    ${result.diffStat}\n`);
        }
      }
      process.stderr.write('\n');
    }
  }

  /** Get the run ID (for testing). */
  getRunId(): string {
    return this.runId;
  }

  /** Get active worktree info (for testing). */
  getInfo(testName: string): WorktreeInfo | undefined {
    return this.active.get(testName);
  }
}
