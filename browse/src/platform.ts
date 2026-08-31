/**
 * Cross-platform constants for gstack browse.
 *
 * On macOS/Linux: TEMP_DIR = '/tmp', path.sep = '/'  — identical to hardcoded values.
 * On Windows: TEMP_DIR = os.tmpdir(), path.sep = '\\' — correct Windows behavior.
 */

import * as os from 'os';
import * as path from 'path';

export const IS_WINDOWS = process.platform === 'win32';
export const TEMP_DIR = IS_WINDOWS ? os.tmpdir() : '/tmp';

/**
 * All temp roots local commands may read/write. On macOS os.tmpdir() is the
 * per-user /var/folders/... dir (not /tmp), and TMPDIR-honoring environments
 * (CI, syscall-supervised sandboxes that screen /tmp) point os.tmpdir()
 * elsewhere entirely — both are legitimate scratch space alongside the
 * classic /tmp. Remote file serving (TEMP_ONLY in path-security.ts) stays
 * pinned to TEMP_DIR alone; this wider set is for LOCAL path validation only.
 */
/** A TMPDIR pointed at `/`, the user's home, or a parent of the daemon's cwd
 *  would widen local path validation to that whole subtree for the daemon's
 *  lifetime — treat such a value as misconfiguration and ignore it. */
function trustableTmpdir(dir: string): boolean {
  const resolved = path.resolve(dir);
  const home = os.homedir();
  if (resolved === path.parse(resolved).root) return false;
  if (resolved === home) return false;
  return !isPathWithin(path.resolve(process.cwd()), resolved) || isPathWithin(resolved, TEMP_DIR);
}

export const TEMP_DIRS = [...new Set([TEMP_DIR, os.tmpdir()].filter((d, i) => i === 0 || trustableTmpdir(d)))];

/** Check if resolvedPath is within dir, using platform-aware separators. */
export function isPathWithin(resolvedPath: string, dir: string): boolean {
  return resolvedPath === dir || resolvedPath.startsWith(dir + path.sep);
}
