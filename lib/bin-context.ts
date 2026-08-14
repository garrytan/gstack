/**
 * bin-context — tiny shared helpers for non-interactive gstack bins that need the
 * project slug, current branch, and argv flags. Extracted from the decision bins
 * (gstack-decision-log / gstack-decision-search) so the slug/branch/flag plumbing
 * lives in one audited place instead of being copy-pasted per bin.
 */

import { spawnSync } from "child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { homedir } from "os";
import { basename, join } from "path";

/** Keep the slug inside the [a-zA-Z0-9._-] alphabet gstack-slug promises (`tr -cd`). */
function sanitizeSlug(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]/g, "");
}

/**
 * A Windows path in the MSYS form git-bash's `pwd` reports:
 * `C:\Users\j\foo` → `/c/Users/j/foo`. gstack-slug keys its cache on THAT form
 * (`tr '/' '_'`), so a native lookup must reproduce it exactly or it misses the very
 * entry gstack-slug wrote and silently re-derives instead of staying consistent.
 * Exported for the cache-key test; non-Windows paths pass through unchanged.
 */
export function toMsysPath(p: string): string {
  const drive = p.match(/^([A-Za-z]):[\\/]/);
  const body = (drive ? p.slice(2) : p).replace(/\\/g, "/");
  return drive ? `/${drive[1].toLowerCase()}${body}` : body;
}

/**
 * Native port of bin/gstack-slug's resolution order, used when that script cannot be
 * spawned (see resolveSlug). Same three steps, same alphabet, same cache file — so
 * this and the shell path always agree. They must: the bins WRITE using this, while
 * the Context Recovery preamble READS using the script.
 */
export function slugFromEnvironment(gstackHome?: string, cwd: string = process.cwd()): string {
  const home = gstackHome || process.env.GSTACK_HOME || join(homedir(), ".gstack");
  const cacheDir = join(home, "slug-cache");
  const cacheFile = join(cacheDir, toMsysPath(cwd).replace(/\//g, "_"));

  let slug = "";
  // 1. cached slug wins (guarantees consistency across sessions)
  if (existsSync(cacheFile)) {
    try {
      slug = sanitizeSlug(readFileSync(cacheFile, "utf-8").trim());
    } catch {
      slug = "";
    }
  }
  // 2. else derive from the git remote: [:/]<owner>/<repo>[.git] → owner-repo
  if (!slug) {
    const r = spawnSync("git", ["remote", "get-url", "origin"], { encoding: "utf-8", cwd });
    const m = (r.stdout || "").trim().match(/[:/]([^/]+\/[^/]+?)(?:\.git)?$/);
    if (m) slug = sanitizeSlug(m[1].replace(/\//g, "-"));
  }
  // 3. else the directory name
  if (!slug) slug = sanitizeSlug(basename(cwd));
  if (!slug) return "unknown";

  // 4. cache it, as gstack-slug does — atomic, and failures stay silent (`|| true`)
  try {
    mkdirSync(cacheDir, { recursive: true });
    const tmp = `${cacheFile}.tmp.${process.pid}`;
    writeFileSync(tmp, slug, "utf-8");
    renameSync(tmp, cacheFile);
  } catch {
    // best-effort cache; a miss only costs a re-derive on the next call
  }
  return slug;
}

/** Windows cannot exec an extensionless `#!/usr/bin/env bash` script (no shebang, no
 *  PATHEXT match for an explicit path), so gstack-slug spawns ENOENT there. */
export const NEEDS_NATIVE_SLUG_ON_WINDOWS = process.platform === "win32";

/**
 * Resolve the project slug via the `gstack-slug` helper (parses `SLUG=...`).
 *
 * On Windows that spawn fails ENOENT (see NEEDS_NATIVE_SLUG_ON_WINDOWS) and `r.stdout`
 * is undefined — the same class of hazard as the gbrain shim spawns in lib/gbrain-exec.ts
 * (#1731). Returning the literal "unknown" filed every decision under
 * ~/.gstack/projects/unknown/ — one bucket shared by every project on the machine —
 * while the bash-side Context Recovery preamble resolved the real slug, found no
 * decisions.active.json there, and skipped through a bare `if [ -f … ]` with no else.
 *
 * Nothing failed, for ten days: BOTH decision bins (log and search) missed identically,
 * so writes and searches stayed consistent with each other, and the only component that
 * resolved correctly was silent by design.
 *
 * `shell: true` is NOT the fix here, unlike #1731: cmd.exe cannot run a bash script
 * either. Nor is re-spawning through `bash` — on Windows that frequently resolves to
 * WSL, whose $HOME and /mnt/c paths yield a different slug AND a different cache
 * directory, trading one split store for another.
 *
 * POSIX behaviour is unchanged: the fallback is win32-only, where the previous result
 * was unconditionally wrong and so has nothing to regress.
 */
export function resolveSlug(slugBinPath: string): string {
  const r = spawnSync(slugBinPath, { encoding: "utf-8" });
  const m = (r.stdout || "").match(/^SLUG=(.+)$/m);
  if (m) return m[1].trim();
  if (NEEDS_NATIVE_SLUG_ON_WINDOWS) return slugFromEnvironment();
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
