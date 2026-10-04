/**
 * bin-context — tiny shared helpers for non-interactive gstack bins that need the
 * project slug, current branch, and argv flags. Extracted from the decision bins
 * (gstack-decision-log / gstack-decision-search) so the slug/branch/flag plumbing
 * lives in one audited place instead of being copy-pasted per bin.
 */

import { spawnSync } from "child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "fs";
import { basename, dirname, isAbsolute, join, resolve } from "path";
import { resolveStateRoot } from "./state-root";
import { legacyRemoteSlug, remoteSlug } from "./remote-identity";

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

/** `-f` in bash terms: a regular file (following symlinks), never a directory. */
function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

// Marker tiers mirror bin/gstack-slug's `_outermost_project_root` exactly.
// STRONG = canonical version-control / language project files ("this directory
// is a real project of its own"); .git is checked separately because it can be
// a directory (normal repo) or a file (worktree / submodule pointer).
// WEAK = content-only project signals (markdown bundles, asset collections).
const STRONG_FILE_MARKERS = [".project.yaml", "package.json", "pyproject.toml", "Cargo.toml", "Gemfile", "go.mod"];
const WEAK_FILE_MARKERS = ["README.md", "README", "README.rst", "LICENSE", "LICENSE.md"];

/**
 * Native port of bin/gstack-slug's `_outermost_project_root`: walk UP
 * from `startDir` tracking the OUTERMOST ancestor holding a strong marker and
 * the outermost holding a weak marker. Outermost STRONG wins; else outermost
 * WEAK; else "". Build/deploy artifacts (.vercel, node_modules, dist, ...) are
 * deliberately NOT markers, so they can't establish a phantom project root.
 *
 * Termination mirrors the bash fix for windows-free-tests: break on dirname's
 * FIXED POINT (drive roots `C:\`, relative `.`, UNC `//srv` never reach the
 * literal "/"), with a 64-depth belt-and-braces cap. Exported for the
 * hostile-path termination tests.
 */
export function outermostProjectRoot(startDir: string): string {
  let dir = startDir;
  let outermostStrong = "";
  let outermostWeak = "";
  let depth = 0;
  while (dir && dir !== "/" && depth < 64) {
    if (existsSync(join(dir, ".git")) || STRONG_FILE_MARKERS.some((m) => isFile(join(dir, m)))) {
      outermostStrong = dir;
    } else if (WEAK_FILE_MARKERS.some((m) => isFile(join(dir, m)))) {
      outermostWeak = dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break; // dirname fixed point (C:\, ., //srv)
    dir = parent;
    depth += 1;
  }
  // Strong markers win over weak; either wins over nothing.
  return outermostStrong || outermostWeak;
}

/**
 * Native port of bin/gstack-slug's `_outermost_remote_repo` (step 1a): walk UP
 * from `startDir` tracking the OUTERMOST ancestor that has a `.git` entry
 * (directory for normal clones, FILE for git-worktrees/submodules — `git -C`
 * resolves a worktree's remote through its main clone) AND whose `origin`
 * remote resolves. This is the canonical-identity walk: a marker-only
 * ancestor with no resolvable origin (stray empty ~/.git, stray package.json)
 * cannot win here, so it cannot hijack remote-derived identity the way it can
 * hijack the marker walk above. Nested-repo semantics preserved: an inner
 * repo under an outer canonical-remote repo still resolves to the OUTER
 * repo's remote (outermost wins). git spawns only at `.git`-bearing ancestors
 * — typically one. Exported for the parity tests.
 */
export function outermostRemoteRepo(startDir: string): { root: string; url: string } {
  let dir = startDir;
  let root = "";
  let url = "";
  let depth = 0;
  while (dir && dir !== "/" && depth < 64) {
    if (existsSync(join(dir, ".git"))) {
      const r = spawnSync("git", ["-C", dir, "remote", "get-url", "origin"], { encoding: "utf-8" });
      const u = r.status === 0 ? (r.stdout || "").trim() : "";
      if (u) {
        root = dir;
        url = u;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break; // dirname fixed point (C:\, ., //srv)
    dir = parent;
    depth += 1;
  }
  return { root, url };
}

/**
 * Native port of bin/gstack-slug's resolution order, used when that script cannot be
 * spawned (see resolveSlug). Same steps, same alphabet, same cache file — so this and
 * the shell path always agree. They must: the bins WRITE using this, while the
 * Context Recovery preamble READS using the script.
 *
 * Resolution order (parity with the bash script, pinned by
 * test/bin-context-windows-slug.test.ts against test/gstack-slug-cwd-walk-up.test.ts
 * and test/gstack-slug-parity.test.ts):
 *   0. $GSTACK_PROJECT_SLUG env override — wins over everything, never cached.
 *   1. Walk UP to the OUTERMOST project root (see outermostProjectRoot). Without
 *      the walk, a nested/vendored repo derived its slug from the INNERMOST
 *      `git remote get-url origin`, splitting the store the bash side keeps whole.
 *   2. Cached slug is sticky (#2212) — EXCEPT two provable bug shapes. Entries
 *      are versioned ("v2:<slug>"); an unversioned entry is recomputed once and
 *      moves only when it equals the pre-#3003 last-two slug of a 3+-segment
 *      remote:
 *      - old-bug shape (#1125): cached value equals basename(cwd) while the
 *        walk-up says cwd is NOT the project root; that cache came from the
 *        pre-walk-up resolver, so recompute and heal.
 *      - degraded-ancestor shape (2026-08-17), STRAY-REPO shape ONLY: cached
 *        equals the marker root's basename, the marker root is anchored by a
 *        .git entry whose origin does NOT resolve (the stray empty ~/.git
 *        live bug), and a remote-bearing repo BELOW it exists — the
 *        pre-remote-first resolver degraded to that stray ancestor's basename
 *        (SLUG=<username>). A marker root anchored by package.json /
 *        pyproject etc. with NO .git is legit #2212 sticky identity and must
 *        NOT be healed. Legit remote-adopting stickiness is safe too: there
 *        the repo that adopted the remote IS the marker root (remote root ==
 *        project root), so the heal never fires.
 *   3. Canonical remote-derived slug from the OUTERMOST remote-bearing repo
 *      (see outermostRemoteRepo — never PROJECT_ROOT, which may be a
 *      marker-only ancestor with no remote): remoteSlug() from
 *      lib/remote-identity.ts — owner-repo for 2-segment and local remotes,
 *      "<last-two>-<16 hex>" for 3+-segment hosted remotes (#3003) —
 *      byte-parity with browse/bin/remote-slug. Degenerate slugs
 *      ("", ".", "..", anything with "/") are rejected — a hostile origin
 *      like `url = ..` must never escape ~/.gstack/projects/<slug>.
 *   4. Project root's basename; else basename(cwd) for plain non-project folders.
 */
/** gstack-slug's per-path cache file: the cwd in MSYS form with "/" → "_". */
export function slugCacheFile(stateRoot: string, cwd: string): string {
  return join(stateRoot, "slug-cache", toMsysPath(cwd).replace(/\//g, "_"));
}

/**
 * Twin of gstack-slug's `_git_common_dir` (#2767): the physical git common dir
 * of the repository holding `cwd` (nearest `.git` entry), read from `.git`
 * files without spawning git; "" outside git. A linked worktree's `.git` file
 * names its gitdir, whose `commondir` file points at the shared dir.
 */
export function gitCommonDir(cwd: string): string {
  let dir = cwd;
  for (let depth = 0; dir && depth < 64; depth++) {
    const dotGit = join(dir, ".git");
    try {
      const st = statSync(dotGit);
      if (st.isDirectory()) return realpathSync(dotGit);
      if (st.isFile()) {
        const m = readFileSync(dotGit, "utf-8").match(/^gitdir: *(.+)$/m);
        if (!m) return "";
        const gitdir = isAbsolute(m[1].trim()) ? m[1].trim() : resolve(dir, m[1].trim());
        let common = gitdir;
        try {
          const rel = readFileSync(join(gitdir, "commondir"), "utf-8").split("\n")[0].trim();
          if (rel) common = isAbsolute(rel) ? rel : resolve(gitdir, rel);
        } catch {
          // no commondir file: a submodule or plain gitdir is its own common dir
        }
        return realpathSync(common);
      }
    } catch {
      // no .git here (or unreadable) — keep walking
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return "";
}

/**
 * The cache entries gstack-slug consults, in its deterministic read order:
 * the repository-scoped entry (keyed on the git common dir), then the main
 * checkout's pre-#2767 per-path entry, then this directory's own per-path
 * entry. Outside git all three collapse to the per-path entry.
 */
export function slugCacheReadOrder(stateRoot: string, cwd: string): string[] {
  const legacy = slugCacheFile(stateRoot, cwd);
  const common = gitCommonDir(cwd);
  if (!common) return [legacy];
  const files = [slugCacheFile(stateRoot, common)];
  if (basename(common) === ".git") files.push(slugCacheFile(stateRoot, dirname(common)));
  files.push(legacy);
  return [...new Set(files)];
}

/** Cache entries written since #3003 carry this version prefix ("v2:<slug>"). */
export const SLUG_CACHE_VERSION_PREFIX = "v2:";

/**
 * The slug a versioned cache entry records for `cwd`, or undefined when there is
 * no entry, the entry predates the versioned format, or its value is unusable
 * (empty, "." or ".." after sanitizing). Never spawns git: hot-path readers
 * (the AskUserQuestion preference hook) rely on gstack-slug, which every skill
 * preamble runs, having already written the entry.
 */
export function readVersionedSlugCache(stateRoot: string, cwd: string): string | undefined {
  const file = slugCacheReadOrder(stateRoot, cwd).find((f) => existsSync(f));
  if (!file) return undefined;
  let raw: string;
  try {
    raw = readFileSync(file, "utf-8");
  } catch {
    return undefined;
  }
  if (!raw.startsWith(SLUG_CACHE_VERSION_PREFIX)) return undefined;
  const slug = sanitizeSlug(raw.slice(SLUG_CACHE_VERSION_PREFIX.length).trim());
  return slug && slug !== "." && slug !== ".." ? slug : undefined;
}

export function slugFromEnvironment(gstackHome?: string, cwd: string = process.cwd()): string {
  const home = gstackHome || resolveStateRoot();
  const cacheDir = join(home, "slug-cache");
  const readOrder = slugCacheReadOrder(home, cwd);
  const cacheFile = readOrder.find((f) => existsSync(f));
  const writeTargets = [readOrder[0], slugCacheFile(home, cwd)];

  // 0. explicit env override — per-invocation escape hatch, never persisted
  //    (caching it would rebind THIS cwd's slug for every later env-less run).
  const envSlug = sanitizeSlug((process.env.GSTACK_PROJECT_SLUG || "").trim());
  if (envSlug && envSlug !== "." && envSlug !== "..") return envSlug;

  // 1. outermost project root along the cwd ancestor chain (may be "").
  const projectRoot = outermostProjectRoot(cwd);

  // Lazy, memoized remote discovery (mirrors gstack-slug's _resolve_remote):
  // needed on exactly two paths — fresh resolution and the degraded-ancestor
  // heal check — so ordinary cache hits stay git-spawn-free.
  let remote: { root: string; url: string } | null = null;
  const resolveRemote = () => (remote ??= outermostRemoteRepo(cwd));

  let slug = "";
  // 2. cached slug is sticky (#2212), except the two provable bug shapes
  //    (old-bug #1125 and degraded-ancestor 2026-08-17 — see the doc above).
  if (cacheFile) {
    try {
      const raw = readFileSync(cacheFile, "utf-8");
      const versioned = raw.startsWith(SLUG_CACHE_VERSION_PREFIX);
      const cached = sanitizeSlug((versioned ? raw.slice(SLUG_CACHE_VERSION_PREFIX.length) : raw).trim());
      if (cached) {
        const pwdBase = sanitizeSlug(basename(cwd));
        const rootBase = projectRoot ? sanitizeSlug(basename(projectRoot)) : "";
        const oldBugShape = cached === pwdBase && projectRoot !== "" && projectRoot !== cwd;
        const degradedAncestorShape =
          !oldBugShape &&
          projectRoot !== "" &&
          cached === rootBase &&
          // STRAY-REPO shape only: the marker root must be anchored by a .git
          // entry whose origin does NOT resolve. A root anchored by
          // package.json etc. (no .git) is legit #2212 sticky identity.
          existsSync(join(projectRoot, ".git")) &&
          (() => {
            const rootOrigin = spawnSync("git", ["-C", projectRoot, "remote", "get-url", "origin"], {
              encoding: "utf-8",
            });
            const rootUrl = rootOrigin.status === 0 ? (rootOrigin.stdout || "").trim() : "";
            if (rootUrl) return false; // marker root's own origin resolves — not the stray shape
            const r = resolveRemote();
            return r.url !== "" && r.root !== projectRoot;
          })();
        if (!oldBugShape && !degradedAncestorShape) {
          slug = cached;
          // Unversioned (pre-#3003) entry: recompute once. Keep the sticky
          // value unless it is exactly the old last-two slug of a 3+-segment
          // remote (mirrors bin/gstack-slug).
          if (!versioned) {
            const { url } = resolveRemote();
            if (url) {
              const upgraded = remoteSlug(url);
              const legacy = legacyRemoteSlug(url);
              if (upgraded && upgraded !== legacy && cached === legacy) slug = upgraded;
            }
          }
        }
      }
    } catch {
      slug = "";
    }
  }
  // 3. canonical remote-derived slug from the outermost remote-bearing repo,
  //    via the shared rule in lib/remote-identity.ts (twin of
  //    bin/gstack-remote-identity.sh): legacy last-two parse for 2-segment and
  //    local remotes, "<last-two>-<16 hex>" for 3+-segment hosted remotes.
  if (!slug) {
    const { url } = resolveRemote();
    if (url) {
      const candidate = remoteSlug(url);
      // Dot-only / degenerate guard (mirrors bin/gstack-slug): a hostile
      // origin like `url = ..` yields "." or ".." here, which would file
      // state OUTSIDE ~/.gstack/projects/. Reject and let the basename
      // fallback below anchor identity instead.
      if (candidate && candidate !== "." && candidate !== ".." && !candidate.includes("/")) {
        slug = candidate;
      }
    }
  }
  // 4. project root's basename, else pwd basename for plain folders.
  if (!slug && projectRoot) slug = sanitizeSlug(basename(projectRoot));
  if (!slug) slug = sanitizeSlug(basename(cwd));
  if (!slug) return "unknown";

  // 5. cache it, as gstack-slug does — atomic, self-healing (only rewrites when
  //    the value changed — single-shot, key-local), and failures stay silent.
  //    Both the repository-scoped entry and this path's entry (#2767).
  for (const target of new Set(writeTargets)) {
    try {
      let current = "";
      try {
        current = readFileSync(target, "utf-8");
      } catch {
        // no cache yet — write below
      }
      if (current !== `${SLUG_CACHE_VERSION_PREFIX}${slug}`) {
        mkdirSync(cacheDir, { recursive: true });
        const tmp = `${target}.tmp.${process.pid}`;
        writeFileSync(tmp, `${SLUG_CACHE_VERSION_PREFIX}${slug}`, "utf-8");
        renameSync(tmp, target);
      }
    } catch {
      // best-effort cache; a miss only costs a re-derive on the next call
    }
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
