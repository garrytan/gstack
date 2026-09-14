/**
 * suggest — should the session-start indexing offer be made for this repo?
 *
 * Portions copyright (c) 2026 Sina Matian, time-attack/gstack (GStack 2), MIT.
 *
 * The offer fires at most once per machine: never when a provider is already
 * selected, never after an explicit decline (`select none`), and never for
 * small repos where grep is already fast. Detection is cheap and local
 * (`git ls-files` count); a non-repo directory never triggers the offer.
 */

import { spawnSync } from "child_process";
import { resolve } from "path";
import { readSelection } from "./selection";

// Single tracked-file-count knob for "large"; add a LOC signal if it misfires.
/** Tracked-file count at which indexing starts paying for itself. */
export const LARGE_REPO_FILE_THRESHOLD = 1000;

export type SuggestReason =
  | "provider-selected"
  | "declined"
  | "not-a-repo"
  | "small-repo"
  | "large-repo";

export interface Suggestion {
  offer: boolean;
  reason: SuggestReason;
  fileCount: number | null;
  threshold: number;
}

/** Count of git-tracked files, or null when the path is not a git repo. */
export function trackedFileCount(repoPath: string): number | null {
  const result = spawnSync("git", ["-C", resolve(repoPath), "ls-files"], {
    encoding: "utf-8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0 || typeof result.stdout !== "string") return null;
  const out = result.stdout.trim();
  return out ? out.split("\n").length : 0;
}

export function shouldOfferIndexing(
  repoPath: string,
  opts: { env?: NodeJS.ProcessEnv; threshold?: number } = {},
): Suggestion {
  const threshold = opts.threshold ?? LARGE_REPO_FILE_THRESHOLD;
  const selection = readSelection(opts.env);
  if (selection.provider) return { offer: false, reason: "provider-selected", fileCount: null, threshold };
  if (selection.declined) return { offer: false, reason: "declined", fileCount: null, threshold };
  const fileCount = trackedFileCount(repoPath);
  if (fileCount === null) return { offer: false, reason: "not-a-repo", fileCount, threshold };
  if (fileCount < threshold) return { offer: false, reason: "small-repo", fileCount, threshold };
  return { offer: true, reason: "large-repo", fileCount, threshold };
}
