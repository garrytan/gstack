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
 *   5. Callers MUST use the returned resolved path for subsequent I/O to prevent
 *      TOCTOU races (symlink swap between check and use)
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

/**
 * Validate a file path for writing (screenshot, pdf, download, scrape, archive).
 * Returns the resolved safe path that callers MUST use for the actual write
 * to prevent TOCTOU symlink races.
 */
export function validateOutputPath(filePath: string): string {
  const resolved = path.resolve(filePath);

  // If the target already exists and is a symlink, resolve through it.
  // Without this, a symlink at /tmp/evil.png → /etc/crontab passes the
  // parent-directory check (parent is /tmp, which is safe) but the actual
  // write follows the symlink to /etc/crontab.
  try {
    const stat = fs.lstatSync(resolved);
    if (stat.isSymbolicLink()) {
      // Resolve the symlink target. For dangling symlinks (target doesn't exist),
      // realpathSync throws ENOENT — use readlinkSync to get the raw target.
      let realTarget: string;
      try {
        realTarget = fs.realpathSync(resolved);
      } catch (linkErr: any) {
        // Dangling symlink: resolve the raw link target to an absolute path
        const rawTarget = fs.readlinkSync(resolved);
        realTarget = path.resolve(path.dirname(resolved), rawTarget);
      }
      const isSafe = SAFE_DIRECTORIES.some(dir => isPathWithin(realTarget, dir));
      if (!isSafe) {
        throw new Error(`Path must be within: ${SAFE_DIRECTORIES.join(', ')}`);
      }
      return realTarget; // return resolved symlink target
    }
    // Existing non-symlink file — resolve through any intermediate symlinks
    // in the path (e.g., /tmp/evil-link/passwd where evil-link → /etc)
    const realExisting = fs.realpathSync(resolved);
    const isSafeExisting = SAFE_DIRECTORIES.some(dir => isPathWithin(realExisting, dir));
    if (!isSafeExisting) {
      throw new Error(`Path must be within: ${SAFE_DIRECTORIES.join(', ')}`);
    }
    return realExisting;
  } catch (e: any) {
    // ENOENT from lstatSync = file doesn't exist yet, fall through to parent-dir check
    if (e.code !== 'ENOENT') throw e;
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
  return realResolved;
}

/**
 * Validate a file path for reading (eval command).
 * Returns the resolved safe path that callers MUST use for the actual read
 * to prevent TOCTOU symlink races.
 */
export function validateReadPath(filePath: string): string {
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
  return realPath;
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
