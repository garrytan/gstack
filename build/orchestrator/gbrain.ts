/**
 * GBrain CLI wrapper for gstack-build state persistence.
 *
 * Architecture: gbrain is the cross-machine mirror; local JSON in
 * ~/.gstack/build-state/ is the source of truth and the always-write
 * path. We write to gbrain best-effort (log warning on failure, never
 * sink the orchestrator). On startup, the orchestrator first looks at
 * the local JSON; if missing AND we're on a fresh machine, it can pull
 * from gbrain to resume a build that was started elsewhere.
 *
 * The CLI shape (per `gbrain --help`):
 *   gbrain put <slug>     reads stdin, writes a wiki page
 *   gbrain get <slug>     outputs the page (with YAML frontmatter)
 *   gbrain --version      health check (success ⇒ CLI works + DB reachable)
 *
 * gbrain wraps every page in frontmatter that we have to strip on read.
 */

import { spawnSync } from 'node:child_process';

const GBRAIN_BIN = process.env.GBRAIN_BIN || 'gbrain';
const PUT_TIMEOUT_MS = 15_000;
const GET_TIMEOUT_MS = 10_000;
const VERSION_TIMEOUT_MS = 3_000;

let _availabilityCache: boolean | null = null;

/**
 * Cheap availability check. Caches the result for the session — gbrain
 * doesn't appear and disappear during a single run.
 *
 * Pass `force=true` to bypass the cache (for tests).
 */
export function isGbrainAvailable(force = false): boolean {
  if (!force && _availabilityCache !== null) return _availabilityCache;
  const result = spawnSync(GBRAIN_BIN, ['--version'], {
    encoding: 'utf8',
    timeout: VERSION_TIMEOUT_MS,
  });
  _availabilityCache = result.status === 0;
  return _availabilityCache;
}

/** For tests: reset the cache. */
export function _resetAvailabilityCache(): void {
  _availabilityCache = null;
}

/**
 * Write a state blob to gbrain. Returns true on success, false on
 * any failure (CLI not on PATH, network error, db unavailable, etc.).
 *
 * Failures are NOT thrown — the caller (state.ts saveState) treats
 * gbrain as a best-effort mirror, never a hard dependency.
 */
export function gbrainPut(slug: string, content: string): boolean {
  if (!isGbrainAvailable()) return false;
  try {
    const result = spawnSync(GBRAIN_BIN, ['put', slug], {
      input: content,
      encoding: 'utf8',
      timeout: PUT_TIMEOUT_MS,
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

/**
 * Read a state blob from gbrain. Returns the body (frontmatter stripped)
 * or null if the page doesn't exist or any error occurs.
 */
export function gbrainGet(slug: string): string | null {
  if (!isGbrainAvailable()) return null;
  try {
    const result = spawnSync(GBRAIN_BIN, ['get', slug], {
      encoding: 'utf8',
      timeout: GET_TIMEOUT_MS,
    });
    if (result.status !== 0) return null;
    return stripFrontmatter(result.stdout);
  } catch {
    return null;
  }
}

/**
 * Strip a leading YAML frontmatter block (`---\n...---\n`) if present.
 * gbrain auto-adds frontmatter (title, type) to every page; our state
 * is the body underneath.
 */
export function stripFrontmatter(content: string): string {
  // Skip leading whitespace (gbrain may add a banner line above).
  let s = content;
  // Drop any leading lines that aren't `---` (e.g. the [gbrain] banner).
  const firstFenceIdx = s.indexOf('---\n');
  if (firstFenceIdx === -1) return s;
  // Look for the closing fence after the opening one.
  const after = s.slice(firstFenceIdx + 4);
  const closeIdx = after.indexOf('\n---\n');
  if (closeIdx === -1) return s;
  // Everything after the closing fence + newline is the body.
  return after.slice(closeIdx + 5).replace(/^\s*\n/, '');
}
