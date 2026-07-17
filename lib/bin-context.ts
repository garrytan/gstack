/**
 * bin-context — tiny shared helpers for non-interactive gstack bins that need the
 * current branch and argv flags. Project identity is resolved directly through
 * runtime/identity.js by callers so native Windows never has to execute a
 * sibling shebang script.
 */

import { spawnSync } from "child_process";

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
