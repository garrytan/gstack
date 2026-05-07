/**
 * Git worktree helpers for dual-implementor mode (--dual-impl).
 *
 * Each phase gets two isolated worktrees:
 *   /tmp/gstack-dual-<slug>-p<N>-<ts>/primary   → branch gstack-dual-p<N>-primary-<ts>
 *   /tmp/gstack-dual-<slug>-p<N>-<ts>/secondary → branch gstack-dual-p<N>-secondary-<ts>
 *
 * Both branches start at the current HEAD of the main cwd.
 * The winning branch's commits are cherry-picked back onto main cwd after judging.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import type { DualImplCandidateKey, DualImplState } from "./types";

// Field names match DualImplState so callers can spread directly.
export interface WorktreePair {
  candidates: DualImplState["candidates"];
  baseCommit: string;
}

// 50 MB is enough for diffs of ~500k lines. spawnSync default 1 MB silently
// truncates output on large refactors — see git diff in applyWinner patch fallback.
const SPAWN_MAX_BUFFER = 50 * 1024 * 1024;

function run(args: string[], cwd: string): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: SPAWN_MAX_BUFFER });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed (cwd=${cwd}): ${r.stderr || r.stdout}`);
  }
  return r.stdout.trim();
}

function tryRun(args: string[], cwd: string): void {
  spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: SPAWN_MAX_BUFFER });
}

/**
 * Creates two worktrees rooted at /tmp/gstack-dual-<slug>-p<N>-<ts>/.
 * On partial failure, rolls back any worktrees already created.
 */
export function createWorktrees(opts: {
  cwd: string;
  slug: string;
  phaseNumber: string;
}): WorktreePair {
  const { cwd, slug, phaseNumber } = opts;
  const ts = Date.now();
  const baseDir = path.join(os.tmpdir(), `gstack-dual-${slug}-p${phaseNumber}-${ts}`);
  const primaryWorktreePath = path.join(baseDir, "primary");
  const secondaryWorktreePath = path.join(baseDir, "secondary");
  const primaryBranch = `gstack-dual-p${phaseNumber}-primary-${ts}`;
  const secondaryBranch = `gstack-dual-p${phaseNumber}-secondary-${ts}`;

  const baseCommit = run(["rev-parse", "HEAD"], cwd);

  fs.mkdirSync(primaryWorktreePath, { recursive: true });
  fs.mkdirSync(secondaryWorktreePath, { recursive: true });

  try {
    run(["worktree", "add", "-b", primaryBranch, primaryWorktreePath, "HEAD"], cwd);
  } catch (err) {
    fs.rmSync(baseDir, { recursive: true, force: true });
    throw err;
  }

  try {
    run(["worktree", "add", "-b", secondaryBranch, secondaryWorktreePath, "HEAD"], cwd);
  } catch (err) {
    tryRun(["worktree", "remove", "--force", primaryWorktreePath], cwd);
    tryRun(["branch", "-D", primaryBranch], cwd);
    fs.rmSync(baseDir, { recursive: true, force: true });
    throw err;
  }

  return {
    candidates: {
      primary: {
        worktreePath: primaryWorktreePath,
        branch: primaryBranch,
      },
      secondary: {
        worktreePath: secondaryWorktreePath,
        branch: secondaryBranch,
      },
    },
    baseCommit,
  };
}

/**
 * Removes both worktrees and their tracking branches.
 * Idempotent — safe to call even if already torn down.
 */
export function teardownWorktrees(opts: { cwd: string; dualImpl: DualImplState }): void {
  const { cwd, dualImpl } = opts;

  for (const wt of [
    dualImpl.candidates.primary.worktreePath,
    dualImpl.candidates.secondary.worktreePath,
  ]) {
    tryRun(["worktree", "remove", "--force", wt], cwd);
  }
  for (const branch of [
    dualImpl.candidates.primary.branch,
    dualImpl.candidates.secondary.branch,
  ]) {
    tryRun(["branch", "-D", branch], cwd);
  }
  tryRun(["worktree", "prune"], cwd);
}

/**
 * Cherry-picks the winner's commits (baseCommit..HEAD in winner's worktree)
 * onto the main cwd branch. Falls back to patch-apply if cherry-pick conflicts.
 */
export function applyWinner(opts: {
  cwd: string;
  winner: DualImplCandidateKey;
  dualImpl: DualImplState;
}): { ok: boolean; error?: string } {
  const { cwd, winner, dualImpl } = opts;
  const worktreePath = dualImpl.candidates[winner].worktreePath;
  const { baseCommit } = dualImpl;

  // Get list of commits from baseCommit..HEAD in winner's worktree
  const logResult = spawnSync(
    "git",
    ["log", "--reverse", "--format=%H", `${baseCommit}..HEAD`],
    { cwd: worktreePath, encoding: "utf8", maxBuffer: SPAWN_MAX_BUFFER }
  );

  if (logResult.status !== 0) {
    return {
      ok: false,
      error: `git log failed in winner worktree (path=${worktreePath}): ${logResult.stderr || logResult.stdout}`,
    };
  }

  const logOutput = logResult.stdout.trim();
  if (!logOutput) {
    return { ok: false, error: "No commits found in winner worktree since base" };
  }

  const commits = logOutput.split("\n").filter(Boolean);

  // Try cherry-pick
  const cherryPick = spawnSync("git", ["cherry-pick", ...commits], {
    cwd,
    encoding: "utf8",
    maxBuffer: SPAWN_MAX_BUFFER,
  });

  if (cherryPick.status === 0) {
    return { ok: true };
  }

  // Cherry-pick failed — abort and try patch fallback
  tryRun(["cherry-pick", "--abort"], cwd);

  // Preflight: verify cwd is clean before attempting patch apply.
  // git apply -3 can partially modify the index AND working tree on conflict;
  // we can only safely recover if the repo started clean.
  const cwdStatus = spawnSync("git", ["status", "--porcelain"], {
    cwd,
    encoding: "utf8",
    maxBuffer: SPAWN_MAX_BUFFER,
  });
  if (cwdStatus.stdout.trim()) {
    return {
      ok: false,
      error: `Cherry-pick failed and cwd is not clean — skipping patch fallback to avoid corrupting repo.\nCherry-pick: ${cherryPick.stderr}\nDirty files:\n${cwdStatus.stdout}`,
    };
  }

  const diff = spawnSync(
    "git",
    ["diff", `${baseCommit}..HEAD`],
    { cwd: worktreePath, encoding: "utf8", maxBuffer: SPAWN_MAX_BUFFER }
  );

  if (!diff.stdout) {
    return { ok: false, error: `Cherry-pick failed and diff is empty: ${cherryPick.stderr}` };
  }

  const apply = spawnSync("git", ["apply", "-3", "-"], {
    cwd,
    input: diff.stdout,
    encoding: "utf8",
    maxBuffer: SPAWN_MAX_BUFFER,
  });

  if (apply.status !== 0) {
    // cwd was verified clean before apply — git reset --hard HEAD restores both
    // the index and working tree, undoing any partial changes git apply left.
    tryRun(["reset", "--hard", "HEAD"], cwd);
    return {
      ok: false,
      error: `Both cherry-pick and patch-apply failed. cwd restored to HEAD.\nCherry-pick: ${cherryPick.stderr}\nApply: ${apply.stderr}`,
    };
  }

  // Stage and commit the patch-applied changes
  const addResult = spawnSync("git", ["add", "-A"], {
    cwd,
    encoding: "utf8",
    maxBuffer: SPAWN_MAX_BUFFER,
  });
  if (addResult.status !== 0) {
    return { ok: false, error: `git add failed after patch apply: ${addResult.stderr}` };
  }

  // Count commits to choose a clean message — avoids dumping N subject lines
  // into one ugly multi-line -m string when N > 1.
  const subjects = spawnSync(
    "git",
    ["log", "--format=%s", `${baseCommit}..HEAD`],
    { cwd: worktreePath, encoding: "utf8", maxBuffer: SPAWN_MAX_BUFFER }
  ).stdout.trim().split("\n").filter(Boolean);

  const msg =
    subjects.length === 0
      ? `Apply ${winner} implementation`
      : subjects.length === 1
        ? subjects[0]
        : `Apply ${winner} implementation (${subjects.length} commits squashed)`;

  const commitResult = spawnSync(
    "git",
    ["commit", "-m", msg],
    { cwd, encoding: "utf8", maxBuffer: SPAWN_MAX_BUFFER }
  );
  if (commitResult.status !== 0) {
    // git apply -3 succeeded but commit failed (e.g. commit-hook, missing user config).
    // The patch is staged but not committed — reset to restore a clean cwd.
    tryRun(["reset", "--hard", "HEAD"], cwd);
    return { ok: false, error: `git commit failed after patch apply: ${commitResult.stderr}` };
  }

  return { ok: true };
}
