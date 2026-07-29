/**
 * bin-context — tiny shared helpers for non-interactive gstack bins that need the
 * project slug, current branch, and argv flags. Extracted from the decision bins
 * (gstack-decision-log / gstack-decision-search) so the slug/branch/flag plumbing
 * lives in one audited place instead of being copy-pasted per bin.
 */

import { spawnSync } from "child_process";
import type { SpawnSyncOptionsWithStringEncoding, SpawnSyncReturns } from "child_process";

/**
 * Spawn one of gstack's own `#!/usr/bin/env bash` bins.
 *
 * Windows has no shebang support, so `spawnSync(bin, ...)` on an extensionless
 * bash script fails with ENOENT. `shell: true` does not help either: that routes
 * through cmd.exe, which reports "is not recognized as an internal or external
 * command". Only spawning `bash` with the script as argv[0] actually starts it.
 *
 * (`shell: true` IS correct for `gbrain` — see NEEDS_SHELL_ON_WINDOWS in
 * lib/gbrain-exec.ts — but only because gbrain ships a `.cmd` shim on Windows,
 * which cmd.exe can run. gstack's own bins have no such shim.)
 *
 * Tries the direct spawn first so POSIX keeps its existing behaviour untouched,
 * and only falls back to bash when the direct spawn produced nothing.
 */
export function spawnBashBin(
  binPath: string,
  args: string[] = [],
  opts: Partial<SpawnSyncOptionsWithStringEncoding> = {},
): SpawnSyncReturns<string> {
  const options = { encoding: "utf-8" as const, ...opts };
  const direct = spawnSync(binPath, args, options);
  if (!direct.error && direct.stdout != null) return direct;
  return spawnSync("bash", [binPath, ...args], options);
}

/** Resolve the project slug via the `gstack-slug` helper (parses `SLUG=...`). */
export function resolveSlug(slugBinPath: string): string {
  const r = spawnBashBin(slugBinPath);
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
