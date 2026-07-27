/**
 * bin-context -- tiny shared helpers for non-interactive gstack bins that need the
 * project slug, current branch, and argv flags. Extracted from the decision bins
 * (gstack-decision-log / gstack-decision-search) so the slug/branch/flag plumbing
 * lives in one audited place instead of being copy-pasted per bin.
 */

import { spawnSync } from "child_process";

/** Resolve the project slug via the `gstack-slug` helper (parses `SLUG=...`). */
export function resolveSlug(slugBinPath: string): string {
  const parse = (out: string | null): string | undefined =>
    (out || "").match(/^SLUG=(.+)$/m)?.[1].trim();

  // Direct call first, so POSIX behaviour is unchanged.
  const direct = spawnSync(slugBinPath, { encoding: "utf-8" });
  const fromDirect = parse(direct.stdout);
  if (fromDirect) return fromDirect;

  // `gstack-slug` is an extension-less bash script. On Windows, spawnSync
  // without a shell goes through CreateProcess, which does not honour
  // shebangs: the call fails with ENOENT and stdout is null. `shell: true`
  // does not help either -- cmd.exe has no association for an extension-less
  // file. Naming the interpreter is what works. Retry whenever the direct
  // call yielded no slug rather than only on ENOENT, so a shim that exits
  // non-zero without output is covered too. bash specifically, not sh:
  // gstack-slug uses `[[ ]]` and `set -o pipefail`.
  const viaBash = spawnSync("bash", [slugBinPath], { encoding: "utf-8" });
  const fromBash = parse(viaBash.stdout);
  if (fromBash) return fromBash;

  // A tooling failure is not an anonymous project, and a mute fallback is what
  // let this live: callers then read and write ~/.gstack/projects/unknown/ --
  // one shared bucket for every repo on the machine on the write side, and on
  // the read side a directory that does not exist, so the search returns an
  // empty list and exits 0. The session is told there are no prior decisions
  // and re-litigates settled calls in good faith. Keep the fallback; never
  // keep it quiet.
  const reason = (r: typeof direct): string =>
    (r.error as NodeJS.ErrnoException | undefined)?.code ??
    r.error?.message ??
    `exited ${r.status}`;
  process.stderr.write(
    `gstack: could not resolve the project slug from ${slugBinPath} ` +
      `(direct: ${reason(direct)}; via bash: ${reason(viaBash)}). ` +
      `Falling back to "unknown" -- decisions will read and write ` +
      `~/.gstack/projects/unknown/ instead of this project.\n`,
  );
  return "unknown";
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
