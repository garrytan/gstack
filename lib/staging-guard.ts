/**
 * staging-guard — fail-closed ownership proof for gstack ingest staging dirs.
 *
 * Fixes #1802. The /sync-gbrain memory stage stages prepared pages to a
 * throwaway dir under ~/.gstack and `rm -rf`s it when done. The resume path
 * (#1611) reused gbrain's `import-checkpoint.json` `dir` field as that staging
 * dir WITHOUT proving it was one. A poisoned checkpoint — `dir` = the repo
 * root, written when an autopilot `gbrain import` was SIGTERM'd while CWD was
 * the repo — was then adopted as the staging dir and recursively deleted,
 * destroying the user's working tree.
 *
 * Root cause is a TRUST failure, not path math: code deleted a path it never
 * proved it owned. This module is the single definition of "a path gstack is
 * allowed to recurse-delete or resume into", shared by the resume gate
 * (decideResume) and the deletion chokepoint (cleanupStagingDir).
 *
 * Ownership requires ALL of the following (fail-closed — any failure ⇒ refuse):
 *   1. Resolvable    — realpathSync succeeds (resolves symlinks and `..` to a
 *                      real location before any structural reasoning).
 *   2. Structural    — canonical path is a DIRECT child of $GSTACK_HOME named
 *                      `.staging-ingest-*` (makeStagingDir's contract).
 *   3. Not a repo    — no `.git` entry inside. A screaming last-line tripwire:
 *                      even a logic error elsewhere can never recurse-delete a
 *                      git working tree.
 *   4. Minted by us  — a `.gstack-staging` marker file (written by
 *                      makeStagingDir) is present. Turns "looks like ours"
 *                      into "was created by us this lineage".
 *
 * Design note (steelman, 2026-06-02): a 4-model review panel split 3-1 on the
 * marker. The dissent argued the structural check alone is sufficient and the
 * marker adds a missing-token failure mode. Adopted anyway because that failure
 * mode is fail-SAFE: a missing marker only forces an unnecessary re-stage
 * (seconds), never a wrong deletion. The asymmetry — the marker can cost work
 * but never data — settles it. The structural check still runs first and cheap.
 *
 * The deeper, "inevitable" fix lives upstream in gbrain: checkpoint.dir should
 * always be a gbrain-minted staging dir, never CWD. This guard is the
 * mitigation at gstack's own rm -rf boundary; see the companion gbrain issue.
 */
import { realpathSync, existsSync, statSync, lstatSync } from "fs";
import { join, dirname, basename } from "path";

/** Basename prefix every makeStagingDir() directory carries. */
export const STAGING_PREFIX = ".staging-ingest-";

/** Marker file minted inside each staging dir at creation. */
export const STAGING_MARKER = ".gstack-staging";

export interface StagingVerdict {
  ok: boolean;
  /** Precise rejection reason, for actionable logging. Undefined when ok. */
  reason?: string;
  /**
   * The realpath-resolved directory the verdict actually validated. Present only
   * when ok. Callers that delete MUST `rmSync` this path, not the raw input —
   * deleting the canonical path closes the TOCTOU gap where the input is a
   * symlink swapped between this check and the delete (#1802 C5).
   */
  canonicalPath?: string;
}

/**
 * Prove (fail-closed) that `dir` is a gstack-owned ingest staging directory
 * that is safe to recurse-delete or resume into. Returns a structured verdict
 * so callers can log exactly why a path was rejected.
 *
 * @param dir         Candidate path (e.g. gbrain checkpoint.dir, or the active staging dir).
 * @param gstackHome  Resolved $GSTACK_HOME (injected for testability).
 */
export function checkOwnedStagingDir(dir: string, gstackHome: string): StagingVerdict {
  if (!dir || typeof dir !== "string") {
    return { ok: false, reason: "empty or non-string path" };
  }
  let canon: string;
  let home: string;
  try {
    canon = realpathSync(dir);
    home = realpathSync(gstackHome);
  } catch {
    // Missing path or broken symlink ⇒ cannot prove ownership ⇒ refuse.
    return { ok: false, reason: "unresolvable path (missing dir or broken symlink)" };
  }
  // The target itself must be a directory (not a file/socket/etc named like one).
  try {
    if (!statSync(canon).isDirectory()) {
      return { ok: false, reason: "not a directory" };
    }
  } catch {
    return { ok: false, reason: "unstattable target" };
  }
  if (dirname(canon) !== home) {
    return { ok: false, reason: `not a direct child of GSTACK_HOME (${home})` };
  }
  if (!basename(canon).startsWith(STAGING_PREFIX)) {
    return { ok: false, reason: `basename does not start with "${STAGING_PREFIX}"` };
  }
  if (existsSync(join(canon, ".git"))) {
    // Tripwire: never recurse-delete anything that looks like a git work tree.
    return { ok: false, reason: "path contains .git — refusing to touch a git working tree" };
  }
  // Marker must be a REGULAR FILE we minted — not a directory or symlink that
  // merely shares the name (lstat, not stat, so a symlink can't impersonate it).
  try {
    if (!lstatSync(join(canon, STAGING_MARKER)).isFile()) {
      return { ok: false, reason: `"${STAGING_MARKER}" exists but is not a regular file` };
    }
  } catch {
    return { ok: false, reason: `missing "${STAGING_MARKER}" marker — not minted by makeStagingDir` };
  }
  return { ok: true, canonicalPath: canon };
}

/** Boolean convenience wrapper around {@link checkOwnedStagingDir}. */
export function isOwnedStagingDir(dir: string, gstackHome: string): boolean {
  return checkOwnedStagingDir(dir, gstackHome).ok;
}
