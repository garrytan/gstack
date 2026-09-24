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
 *   3. SAFE_DIRECTORIES = [...TEMP_DIRS, cwd] for local commands (TEMP_DIRS =
 *      classic TEMP_DIR plus os.tmpdir(), which differ on macOS and under
 *      TMPDIR-honoring CI/sandbox environments)
 *   4. TEMP_ONLY = [TEMP_DIR] for remote file serving (prevents project file exfil)
 */

import * as fs from 'fs';
import * as path from 'path';
import { TEMP_DIR, TEMP_DIRS, isPathWithin } from './platform';

// Resolve safe directories through realpathSync to handle symlinks (e.g., macOS /tmp → /private/tmp)
export const SAFE_DIRECTORIES = [...TEMP_DIRS, process.cwd()].map(d => {
  try { return fs.realpathSync(d); } catch { return d; }
});

const TEMP_ONLY = [TEMP_DIR].map(d => {
  try { return fs.realpathSync(d); } catch { return d; }
});

/** Validate a file path for writing (screenshot, pdf, download, scrape, archive). */
export function validateOutputPath(filePath: string): void {
  for (const spelling of new Set([filePath, path.resolve(filePath)])) {
    const root = path.parse(spelling).root;
    let resolved = path.resolve(root || '.');
    const components = spelling.slice(root.length).split(process.platform === 'win32' ? /[\\/]+/ : /\/+/);
    for (const component of components) {
      if (!component || component === '.') continue;
      if (component === '..') {
        resolved = path.dirname(resolved);
        continue;
      }
      resolved = path.join(resolved, component);
      try {
        fs.lstatSync(resolved);
      } catch (err: any) {
        if (err.code === 'ENOENT') continue;
        throw new Error(`Path must be within: ${SAFE_DIRECTORIES.join(', ')}`);
      }
      try {
        resolved = fs.realpathSync.native(resolved);
      } catch {
        throw new Error(`Path must be within: ${SAFE_DIRECTORIES.join(', ')}`);
      }
    }
    if (!SAFE_DIRECTORIES.some(dir => isPathWithin(resolved, dir))) {
      throw new Error(`Path must be within: ${SAFE_DIRECTORIES.join(', ')}`);
    }
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
