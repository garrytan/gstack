/**
 * Shared utilities for gstack.
 *
 * Extracted from eval-store.ts, session-runner.ts, eval-watch.ts to avoid
 * duplication. All functions are pure or side-effect-minimal.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawnSync } from 'child_process';

// --- Paths ---

export const GSTACK_STATE_DIR = process.env.GSTACK_STATE_DIR || path.join(os.homedir(), '.gstack');
export const GSTACK_DEV_DIR = path.join(os.homedir(), '.gstack-dev');

/** Get the projects directory, optionally scoped to a specific project slug. */
export function getProjectsDir(slug?: string): string {
  const base = path.join(GSTACK_STATE_DIR, 'projects');
  return slug ? path.join(base, slug) : base;
}

// --- File I/O ---

/** Atomic write: write to .tmp then rename. Non-fatal on error. */
export function atomicWriteSync(filePath: string, data: string): void {
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, filePath);
}

/** Atomic JSON write: stringify + atomic write. Creates parent dirs. */
export function atomicWriteJSON(filePath: string, data: unknown, mode?: number): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const content = JSON.stringify(data, null, 2) + '\n';
  atomicWriteSync(filePath, content);
  if (mode !== undefined) {
    fs.chmodSync(filePath, mode);
  }
}

/** Read and parse a JSON file, returning null on any error. */
export function readJSON<T>(filePath: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

// --- Git ---

/** Detect the git repository root, or null if not in a repo. */
export function getGitRoot(): string | null {
  try {
    const proc = spawnSync('git', ['rev-parse', '--show-toplevel'], {
      stdio: 'pipe',
      timeout: 2_000,
    });
    if (proc.status !== 0) return null;
    return proc.stdout?.toString().trim() || null;
  } catch {
    return null;
  }
}

/** Get current branch name and short SHA. */
export function getGitInfo(): { branch: string; sha: string } {
  try {
    const branch = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { stdio: 'pipe', timeout: 5000 });
    const sha = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { stdio: 'pipe', timeout: 5000 });
    return {
      branch: branch.stdout?.toString().trim() || 'unknown',
      sha: sha.stdout?.toString().trim() || 'unknown',
    };
  } catch {
    return { branch: 'unknown', sha: 'unknown' };
  }
}

/**
 * Derive a slug from the git remote origin URL (owner-repo format).
 * Falls back to the directory basename if no remote is configured.
 */
export function getRemoteSlug(): string {
  try {
    const proc = spawnSync('git', ['remote', 'get-url', 'origin'], {
      stdio: 'pipe',
      timeout: 2_000,
    });
    if (proc.status !== 0) throw new Error('no remote');
    const url = proc.stdout?.toString().trim() || '';
    // SSH:   git@github.com:owner/repo.git → owner-repo
    // HTTPS: https://github.com/owner/repo.git → owner-repo
    const match = url.match(/[:/]([^/]+)\/([^/]+?)(?:\.git)?$/);
    if (match) return `${match[1]}-${match[2]}`.toLowerCase();
    throw new Error('unparseable');
  } catch {
    const root = getGitRoot();
    return path.basename(root || process.cwd());
  }
}

// --- Version ---

/** Read the gstack version from package.json. */
export function getVersion(): string {
  try {
    // Try relative to this file first (lib/), then try common locations
    const candidates = [
      path.resolve(__dirname, '..', 'package.json'),
      path.resolve(__dirname, '..', '..', 'package.json'),
    ];
    for (const pkgPath of candidates) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
        if (pkg.version) return pkg.version;
      } catch { continue; }
    }
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

// --- Eval I/O ---

export const EVAL_DIR = path.join(GSTACK_DEV_DIR, 'evals');

/** Format ISO timestamp to "YYYY-MM-DD HH:MM" for display. */
export function formatTimestamp(iso: string): string {
  return iso.replace('T', ' ').slice(0, 16);
}

/**
 * List JSON eval files in the eval directory, sorted by filename descending (newest first).
 * Returns full paths. Returns empty array if directory doesn't exist.
 */
export function listEvalFiles(evalDir?: string): string[] {
  const dir = evalDir || EVAL_DIR;
  try {
    const files = fs.readdirSync(dir)
      .filter(f => f.endsWith('.json') && !f.startsWith('_'));
    files.sort().reverse();
    return files.map(f => path.join(dir, f));
  } catch {
    return [];
  }
}

/**
 * Load and parse all eval result JSON files from the eval directory.
 * Skips files that fail to parse. Sorted newest-first by timestamp.
 * Optional limit returns only the N most recent.
 */
export function loadEvalResults<T = unknown>(evalDir?: string, limit?: number): T[] {
  const files = listEvalFiles(evalDir);
  const results: Array<{ data: T; timestamp: string }> = [];
  for (const file of files) {
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
      results.push({ data, timestamp: data.timestamp || '' });
    } catch { continue; }
  }
  results.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  const sliced = limit ? results.slice(0, limit) : results;
  return sliced.map(r => r.data);
}

// --- String helpers ---

/** Sanitize a name for use as a filename: strip leading slashes, replace / with - */
export function sanitizeForFilename(name: string): string {
  return name.replace(/^\/+/, '').replace(/\//g, '-');
}
