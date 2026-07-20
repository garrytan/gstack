/**
 * Shared path validation — single source of truth for file path security.
 *
 * Previously duplicated across write-commands.ts, meta-commands.ts, and read-commands.ts.
 * All file I/O commands (screenshot, pdf, download, scrape, archive, eval) must
 * validate paths through these functions.
 *
 *   validateOutputPath(path)   — for writing files (screenshot, pdf, download, scrape, archive)
 *   validateReadPath(path)     — for reading files (eval)
 *   validateTempPath(path)     — for serving files to remote agents (GET /file, TEMP_DIR only)
 *
 * Security invariants:
 *   1. All paths resolved to absolute before checking
 *   2. Symlinks resolved to catch traversal via symlink inside safe dir
 *   3. SAFE_DIRECTORIES = [TEMP_DIR, cwd] for local commands
 *   4. TEMP_ONLY = [TEMP_DIR] for remote file serving (prevents project file exfil)
 */

import * as fs from 'fs';
import * as path from 'path';
import { TEMP_DIR, isPathWithin } from './platform';

// Resolve safe directories through realpathSync to handle symlinks (e.g., macOS /tmp → /private/tmp)
export const SAFE_DIRECTORIES = [TEMP_DIR, process.cwd()].map(d => {
  try { return fs.realpathSync(d); } catch { return d; }
});

const TEMP_ONLY = [TEMP_DIR].map(d => {
  try { return fs.realpathSync(d); } catch { return d; }
});

/** Validate a file path for writing (screenshot, pdf, download, scrape, archive). */
export function validateOutputPath(filePath: string): void {
  const resolved = path.resolve(filePath);

  // If the target already exists and is a symlink, resolve through it.
  // Without this, a symlink at /tmp/evil.png → /etc/crontab passes the
  // parent-directory check (parent is /tmp, which is safe) but the actual
  // write follows the symlink to /etc/crontab.
  let stat: fs.Stats | undefined;
  try {
    stat = fs.lstatSync(resolved);
  } catch (e: any) {
    // ENOENT from lstat means the output file itself does not exist yet.
    // Do not put realpathSync in this catch: ENOENT there means an existing
    // dangling symlink, which must fail closed instead of being treated as a
    // new file whose parent is safe.
    if (e.code !== 'ENOENT') throw e;
  }
  if (stat?.isSymbolicLink()) {
    let realTarget: string;
    try {
      realTarget = fs.realpathSync(resolved);
    } catch {
      throw new Error(`Path must be within: ${SAFE_DIRECTORIES.join(', ')}`);
    }
    const isSafe = SAFE_DIRECTORIES.some(dir => isPathWithin(realTarget, dir));
    if (!isSafe) {
      throw new Error(`Path must be within: ${SAFE_DIRECTORIES.join(', ')}`);
    }
    return; // symlink target verified, no need to check parent
  }

  // For new files (no existing symlink), verify the parent directory.
  // The file itself may not exist yet (e.g., screenshot output).
  // This also handles macOS /tmp → /private/tmp transparently.
  let dir = path.dirname(resolved);
  let realDir: string;
  try {
    realDir = fs.realpathSync(dir);
  } catch {
    try {
      realDir = fs.realpathSync(path.dirname(dir));
    } catch {
      throw new Error(`Path must be within: ${SAFE_DIRECTORIES.join(', ')}`);
    }
  }

  const realResolved = path.join(realDir, path.basename(resolved));
  const isSafe = SAFE_DIRECTORIES.some(dir => isPathWithin(realResolved, dir));
  if (!isSafe) {
    throw new Error(`Path must be within: ${SAFE_DIRECTORIES.join(', ')}`);
  }
}

/** Validate a file path for reading (eval command). */
export function validateReadPath(filePath: string): void {
  const resolved = path.resolve(filePath);
  let realPath: string;
  try {
    realPath = fs.realpathSync(resolved);
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      try {
        const dir = fs.realpathSync(path.dirname(resolved));
        realPath = path.join(dir, path.basename(resolved));
      } catch {
        realPath = resolved;
      }
    } else {
      throw new Error(`Cannot resolve real path: ${filePath} (${err.code})`);
    }
  }
  const isSafe = SAFE_DIRECTORIES.some(dir => isPathWithin(realPath, dir));
  if (!isSafe) {
    throw new Error(`Path must be within: ${SAFE_DIRECTORIES.join(', ')}`);
  }
}

/** Validate a file path for remote serving (GET /file). TEMP_DIR only, not cwd. */
export function validateTempPath(filePath: string): void {
  const resolved = path.resolve(filePath);
  let realPath: string;
  try {
    realPath = fs.realpathSync(resolved);
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      throw new Error('File not found');
    }
    throw new Error(`Cannot resolve path: ${filePath}`);
  }
  const isSafe = TEMP_ONLY.some(dir => isPathWithin(realPath, dir));
  if (!isSafe) {
    throw new Error(`Path must be within: ${TEMP_ONLY.join(', ')} (remote file serving is restricted to temp directory)`);
  }
}

/** Escape special regex metacharacters in a user-supplied string to prevent ReDoS. */
export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
