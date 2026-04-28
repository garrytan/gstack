/**
 * Git worktree helpers for dual-implementor mode (--dual-impl).
 *
 * Each phase gets two isolated worktrees:
 *   /tmp/gstack-dual-<slug>-p<N>-<ts>/gemini  → branch gstack-dual-p<N>-gemini-<ts>
 *   /tmp/gstack-dual-<slug>-p<N>-<ts>/codex   → branch gstack-dual-p<N>-codex-<ts>
 *
 * Both branches start at the current HEAD of the main cwd.
 * The winning branch's commits are cherry-picked back onto main cwd after judging.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import type { DualImplState } from "./types";

// Field names match DualImplState so callers can spread directly.
export interface WorktreePair {
  geminiWorktreePath: string;
  codexWorktreePath: string;
  geminiBranch: string;
  codexBranch: string;
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
  const geminiWorktreePath = path.join(baseDir, "gemini");
  const codexWorktreePath = path.join(baseDir, "codex");
  const geminiBranch = `gstack-dual-p${phaseNumber}-gemini-${ts}`;
  const codexBranch = `gstack-dual-p${phaseNumber}-codex-${ts}`;

  const baseCommit = run(["rev-parse", "HEAD"], cwd);

  fs.mkdirSync(geminiWorktreePath, { recursive: true });
  fs.mkdirSync(codexWorktreePath, { recursive: true });

  try {
    run(["worktree", "add", "-b", geminiBranch, geminiWorktreePath, "HEAD"], cwd);
  } catch (err) {
    fs.rmSync(baseDir, { recursive: true, force: true });
    throw err;
  }

  try {
    run(["worktree", "add", "-b", codexBranch, codexWorktreePath, "HEAD"], cwd);
  } catch (err) {
    tryRun(["worktree", "remove", "--force", geminiWorktreePath], cwd);
    tryRun(["branch", "-D", geminiBranch], cwd);
    fs.rmSync(baseDir, { recursive: true, force: true });
    throw err;
  }

  return { geminiWorktreePath, codexWorktreePath, geminiBranch, codexBranch, baseCommit };
}

/**
 * Removes both worktrees and their tracking branches.
 * Idempotent — safe to call even if already torn down.
 */
export function teardownWorktrees(opts: { cwd: string; dualImpl: DualImplState }): void {
  const { cwd, dualImpl } = opts;
  const { geminiWorktreePath, codexWorktreePath, geminiBranch, codexBranch } = dualImpl;

  for (const wt of [geminiWorktreePath, codexWorktreePath]) {
    tryRun(["worktree", "remove", "--force", wt], cwd);
  }
  for (const branch of [geminiBranch, codexBranch]) {
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
  winner: "gemini" | "codex";
  dualImpl: DualImplState;
}): { ok: boolean; error?: string } {
  const { cwd, winner, dualImpl } = opts;
  const worktreePath =
    winner === "gemini" ? dualImpl.geminiWorktreePath : dualImpl.codexWorktreePath;
  const { baseCommit } = dualImpl;

  // Get list of commits from baseCommit..HEAD in winner's worktree
  const logOutput = spawnSync(
    "git",
    ["log", "--reverse", "--format=%H", `${baseCommit}..HEAD`],
    { cwd: worktreePath, encoding: "utf8", maxBuffer: SPAWN_MAX_BUFFER }
  ).stdout.trim();

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
    return {
      ok: false,
      error: `Both cherry-pick and patch-apply failed.\nCherry-pick: ${cherryPick.stderr}\nApply: ${apply.stderr}`,
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
    return { ok: false, error: `git commit failed after patch apply: ${commitResult.stderr}` };
  }

  return { ok: true };
}
