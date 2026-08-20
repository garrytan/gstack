/**
 * Atomic file writes — the ONE implementation of tmp-write-then-rename.
 *
 * Before this module, the pattern was reimplemented ~20 times across lib/,
 * bin/, and browse/src with three different tmp-suffix conventions — one of
 * which (a bare `.tmp`) carries a real collision race that browse's
 * server.ts documented after hitting it in production: two writers (batch
 * subcommands, /tunnel/start handlers, or any combination) collide on the
 * rename when the tmp filename is deterministic. The suffix here includes
 * pid AND a random component so concurrent writers in the SAME process
 * (async interleavings) can't collide either.
 *
 * Contract:
 * - atomicWriteSync ALWAYS throws on failure, after best-effort tmp cleanup.
 *   Callers own the error. Use it everywhere except shutdown paths.
 * - atomicWriteQuiet swallows everything (returns false on failure). ONLY
 *   for shutdown/emergency-cleanup paths where a throw would abort the rest
 *   of cleanup — same philosophy as browse's safeUnlinkQuiet.
 * - `mode` applies to the tmp file at creation (0600 for sensitive state),
 *   so the final file never exists with looser permissions.
 * - The tmp file is created in the target's directory (same filesystem, so
 *   rename stays atomic). Parent dirs are NOT created — callers that need
 *   mkdir own that decision (and its mode).
 */
import * as fs from 'fs';
import * as crypto from 'crypto';

export interface AtomicWriteOpts {
  /** File mode for the tmp file at creation (e.g. 0o600). Default: umask. */
  mode?: number;
}

function tmpPathFor(target: string): string {
  return `${target}.tmp.${process.pid}.${crypto.randomBytes(4).toString('hex')}`;
}

/** Atomic write. Throws on failure (after best-effort tmp cleanup). */
export function atomicWriteSync(
  target: string,
  data: string | NodeJS.ArrayBufferView,
  opts: AtomicWriteOpts = {},
): void {
  const tmp = tmpPathFor(target);
  try {
    if (opts.mode !== undefined) {
      fs.writeFileSync(tmp, data, { mode: opts.mode });
    } else {
      fs.writeFileSync(tmp, data);
    }
    fs.renameSync(tmp, target);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // Best-effort cleanup; the original error is the one that matters.
    }
    throw err;
  }
}

/**
 * Atomic write that swallows all errors. Returns true on success.
 * ONLY for shutdown/emergency paths — a throw there aborts remaining cleanup.
 */
export function atomicWriteQuiet(
  target: string,
  data: string | NodeJS.ArrayBufferView,
  opts: AtomicWriteOpts = {},
): boolean {
  try {
    atomicWriteSync(target, data, opts);
    return true;
  } catch {
    return false;
  }
}
