/**
 * bin-context — tiny shared helpers for non-interactive gstack bins that need the
 * project slug, current branch, and argv flags. Extracted from the decision bins
 * (gstack-decision-log / gstack-decision-search) so the slug/branch/flag plumbing
 * lives in one audited place instead of being copy-pasted per bin.
 */

import { spawnSync } from "child_process";

/** Resolve the project slug via the `gstack-slug` helper (parses `SLUG=...`). */
export function resolveSlug(slugBinPath: string): string {
  const r = spawnSync(slugBinPath, { encoding: "utf-8" });
  const m = (r.stdout || "").match(/^SLUG=(.+)$/m);
  return m ? m[1].trim() : "unknown";
}

/** Current git branch, or undefined on detached HEAD / outside a repo. */
export function gitBranch(): string | undefined {
  const r = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf-8" });
  const b = (r.stdout || "").trim();
  return b && b !== "HEAD" ? b : undefined;
}

/** The value following `--flag` in argv, or undefined if absent. */
export function flagValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}
