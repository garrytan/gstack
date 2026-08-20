import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  toMsysPath,
  slugFromEnvironment,
  outermostProjectRoot,
  resolveSlug,
  NEEDS_NATIVE_SLUG_ON_WINDOWS,
} from "../lib/bin-context";

const ROOT = path.resolve(import.meta.dir, "..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf-8");

let tmp: string;
let savedEnvSlug: string | undefined;
beforeEach(() => {
  // realpathSync so the native cwd matches what the bash script's `pwd` reports
  // (macOS: /var/folders/... is a symlink to /private/var/folders/...).
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "gstack-slug-")));
  // An ambient GSTACK_PROJECT_SLUG (leaked from an operator shell or a sibling
  // test in a shared-process shard) would override every derivation under test.
  savedEnvSlug = process.env.GSTACK_PROJECT_SLUG;
  delete process.env.GSTACK_PROJECT_SLUG;
});
afterEach(() => {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  if (savedEnvSlug === undefined) delete process.env.GSTACK_PROJECT_SLUG;
  else process.env.GSTACK_PROJECT_SLUG = savedEnvSlug;
});

/**
 * Windows cannot exec bin/gstack-slug -- a `#!/usr/bin/env bash` script with no file
 * extension -- so spawnSync fails ENOENT and resolveSlug used to return the literal
 * string "unknown". Every decision on the machine landed in one shared
 * ~/.gstack/projects/unknown/ bucket, while the bash-side Context Recovery preamble
 * resolved the real slug and silently found nothing there.
 *
 * These exercise the native fallback on EVERY platform (it is only the *gating* that
 * is win32-specific), so macOS/Linux CI catches a regression that would otherwise
 * only ever surface on a Windows user's disk.
 */
describe("native slug fallback mirrors bin/gstack-slug", () => {
  test("toMsysPath reproduces the git-bash cache key", () => {
    // gstack-slug does: CACHE_KEY=$(printf '%s' "$(pwd)" | tr '/' '_')
    // and git-bash `pwd` reports C:\Users\j\foo as /c/Users/j/foo.
    expect(toMsysPath("C:\\Users\\j\\foo")).toBe("/c/Users/j/foo");
    expect(toMsysPath("D:/Work/Repo")).toBe("/d/Work/Repo");
    expect(toMsysPath("/already/posix")).toBe("/already/posix");
    // The cache FILENAME is the real contract:
    expect(toMsysPath("C:\\Users\\j\\foo").replace(/\//g, "_")).toBe("_c_Users_j_foo");
  });

  test("step 1: a cached slug wins over everything else", () => {
    const cwd = path.join(tmp, "proj");
    fs.mkdirSync(cwd);
    const cacheDir = path.join(tmp, "home", "slug-cache");
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(path.join(cacheDir, toMsysPath(cwd).replace(/\//g, "_")), "cached-wins");
    expect(slugFromEnvironment(path.join(tmp, "home"), cwd)).toBe("cached-wins");
  });

  test("step 2: derives owner-repo from the git remote, https and ssh alike", () => {
    for (const [url, want] of [
      ["https://github.com/acme/Widget.git", "acme-Widget"],
      ["git@github.com:acme/Widget.git", "acme-Widget"],
      ["https://gitlab.com/acme/Widget", "acme-Widget"],
    ] as const) {
      const cwd = fs.mkdtempSync(path.join(tmp, "repo-"));
      spawnSync("git", ["init", "-q"], { cwd });
      spawnSync("git", ["remote", "add", "origin", url], { cwd });
      expect(slugFromEnvironment(path.join(tmp, "home2"), cwd)).toBe(want);
    }
  });

  test("step 3: falls back to the sanitized directory name", () => {
    // `tr -cd 'a-zA-Z0-9._-'` DELETES disallowed characters rather than replacing them.
    const cwd = path.join(tmp, "My Proj+v2");
    fs.mkdirSync(cwd);
    expect(slugFromEnvironment(path.join(tmp, "home3"), cwd)).toBe("MyProjv2");
  });

  test("the resolved slug is cached back, as the shell script does", () => {
    const cwd = path.join(tmp, "cacheme");
    fs.mkdirSync(cwd);
    const home = path.join(tmp, "home4");
    const slug = slugFromEnvironment(home, cwd);
    const key = path.join(home, "slug-cache", toMsysPath(cwd).replace(/\//g, "_"));
    expect(fs.existsSync(key)).toBe(true);
    // no trailing newline: gstack-slug writes with printf '%s'
    expect(fs.readFileSync(key, "utf-8")).toBe(slug);
  });

  test("never returns the empty string", () => {
    expect(slugFromEnvironment(path.join(tmp, "h"), tmp).length).toBeGreaterThan(0);
  });
});

describe("the fallback stays win32-gated", () => {
  // Static tripwire in the style of gbrain-spawn-windows-shell.test.ts: POSIX CI
  // cannot observe the Windows branch at runtime, so pin the gate itself. Removing
  // it would silently change macOS/Linux behaviour, which today is byte-identical.
  test("NEEDS_NATIVE_SLUG_ON_WINDOWS is platform-gated", () => {
    expect(read("lib/bin-context.ts")).toMatch(
      /export const NEEDS_NATIVE_SLUG_ON_WINDOWS\s*=\s*process\.platform === "win32"/,
    );
    expect(NEEDS_NATIVE_SLUG_ON_WINDOWS).toBe(process.platform === "win32");
  });

  test("resolveSlug no longer returns a bare literal on a failed spawn", () => {
    const src = read("lib/bin-context.ts");
    expect(src).not.toMatch(/return m \? m\[1\]\.trim\(\) : "unknown";/);
    expect(src).toMatch(/if \(NEEDS_NATIVE_SLUG_ON_WINDOWS\) return slugFromEnvironment\(\);/);
  });

  test("a spawn that cannot run resolves to a real slug, not 'unknown'", () => {
    // The exact production failure: the helper path does not exist / cannot exec.
    const got = resolveSlug(path.join(tmp, "definitely-not-a-real-bin"));
    if (NEEDS_NATIVE_SLUG_ON_WINDOWS) {
      expect(got).not.toBe("unknown");
    } else {
      expect(got).toBe("unknown"); // POSIX behaviour deliberately unchanged
    }
  });
});

/**
 * Walk-up parity: the native fallback must resolve the same OUTERMOST project
 * root as bin/gstack-slug's `_outermost_project_root` (see
 * test/gstack-slug-cwd-walk-up.test.ts for the bash-side pins). Before this
 * port, the native path derived the slug from `git remote get-url origin` in
 * cwd — the INNERMOST repo — so a Windows session inside a nested/vendored
 * repo or an artifact-only subdir filed its state under a different slug than
 * every bash-side consumer.
 *
 * Each scenario is run through BOTH implementations on the same fixture
 * (separate GSTACK_HOMEs so neither reads the other's cache) and pinned to the
 * same expected slug. The bash leg is skipped on win32, where bash isn't
 * reliably spawnable — the native leg still pins the ported semantics there.
 */
describe("walk-up parity with bin/gstack-slug (outermost project root)", () => {
  const SCRIPT = path.join(ROOT, "bin", "gstack-slug");
  const HAS_BASH = process.platform !== "win32";

  function bashSlug(cwd: string, extraEnv: Record<string, string> = {}): string {
    const env: Record<string, string | undefined> = {
      ...process.env,
      HOME: path.join(tmp, "bash-home"),
      GSTACK_HOME: path.join(tmp, "bash-home", ".gstack"),
    };
    delete env.GSTACK_PROJECT_SLUG; // only set when a scenario passes it explicitly
    Object.assign(env, extraEnv);
    const r = spawnSync("bash", [SCRIPT], { cwd, env, encoding: "utf-8", timeout: 10_000 });
    const m = (r.stdout || "").match(/^SLUG=([^\n]*)$/m);
    return m ? m[1] : "";
  }

  const nativeHome = () => path.join(tmp, "native-home");

  /** Assert native === expected, and bash === expected where bash is available. */
  function expectBoth(cwd: string, expected: string) {
    expect(slugFromEnvironment(nativeHome(), cwd)).toBe(expected);
    if (HAS_BASH) expect(bashSlug(cwd)).toBe(expected);
  }

  test("AC-1: .git at root, artifact-only subdir — slug is the ROOT basename", () => {
    const projectRoot = path.join(tmp, "loadout");
    const siteSubdir = path.join(projectRoot, "site");
    fs.mkdirSync(path.join(projectRoot, ".git"), { recursive: true });
    fs.mkdirSync(path.join(siteSubdir, ".vercel"), { recursive: true });
    fs.writeFileSync(path.join(siteSubdir, ".vercel", "project.json"), "{}\n");
    expectBoth(siteSubdir, "loadout");
  });

  test("AC-1 variant: package.json at root, node_modules-only subdir — ROOT basename", () => {
    const projectRoot = path.join(tmp, "monorepo");
    const subdir = path.join(projectRoot, "packages", "web");
    fs.mkdirSync(subdir, { recursive: true });
    fs.writeFileSync(path.join(projectRoot, "package.json"), "{}\n");
    fs.mkdirSync(path.join(subdir, "node_modules"), { recursive: true });
    expectBoth(subdir, "monorepo");
  });

  test("AC-2: stale cache (old-bug shape) self-heals to the outermost-root slug", () => {
    const projectRoot = path.join(tmp, "loadout");
    const siteSubdir = path.join(projectRoot, "site");
    fs.mkdirSync(path.join(projectRoot, ".git"), { recursive: true });
    fs.mkdirSync(path.join(siteSubdir, ".vercel"), { recursive: true });
    // Pre-seed the native cache with the WRONG value (pre-walk-up poisoning:
    // cached == basename(pwd) while pwd is NOT the project root).
    const cacheDir = path.join(nativeHome(), "slug-cache");
    fs.mkdirSync(cacheDir, { recursive: true });
    const cacheFile = path.join(cacheDir, toMsysPath(siteSubdir).replace(/\//g, "_"));
    fs.writeFileSync(cacheFile, "site");

    expect(slugFromEnvironment(nativeHome(), siteSubdir)).toBe("loadout");
    // The cache file itself must have been overwritten (self-healing).
    expect(fs.readFileSync(cacheFile, "utf-8")).toBe("loadout");
  });

  test("sticky cache (#2212): a cached identity that is NOT the old-bug shape survives", () => {
    const projectRoot = path.join(tmp, "renamed-project");
    fs.mkdirSync(path.join(projectRoot, ".git"), { recursive: true });
    const cacheDir = path.join(nativeHome(), "slug-cache");
    fs.mkdirSync(cacheDir, { recursive: true });
    const cacheFile = path.join(cacheDir, toMsysPath(projectRoot).replace(/\//g, "_"));
    fs.writeFileSync(cacheFile, "legacy-name");
    // cached != basename(pwd), so the sticky rule holds — no recompute.
    expect(slugFromEnvironment(nativeHome(), projectRoot)).toBe("legacy-name");
  });

  test("AC-3: cwd IS the project root with .git — slug = basename", () => {
    const projectRoot = path.join(tmp, "myproject");
    fs.mkdirSync(path.join(projectRoot, ".git"), { recursive: true });
    expectBoth(projectRoot, "myproject");
  });

  test("AC-4: no markers anywhere on the chain — slug = pwd basename (fallback)", () => {
    const deep = path.join(tmp, "just", "a", "plain", "folder");
    fs.mkdirSync(deep, { recursive: true });
    expectBoth(deep, "folder");
  });

  test("AC-5: subdir of a repo with a remote — slug derived from the ROOT's remote", () => {
    // Pins the `git -C "$PROJECT_ROOT"` port: the subdir has no repo of its
    // own, so the old native path (git in cwd) also reached the parent repo —
    // but only the walk-up guarantees BOTH implementations root the remote
    // lookup at the same directory.
    const projectRoot = path.join(tmp, "realgit");
    const subdir = path.join(projectRoot, "src", "deep");
    fs.mkdirSync(subdir, { recursive: true });
    spawnSync("git", ["init", "-q", projectRoot]);
    spawnSync("git", ["-C", projectRoot, "remote", "add", "origin", "https://github.com/foo/bar.git"]);
    expectBoth(subdir, "foo-bar");
  });

  test("weak marker: README.md at root, artifact-only subdir — ROOT basename", () => {
    const projectRoot = path.join(tmp, "loadout");
    const siteSubdir = path.join(projectRoot, "site");
    fs.mkdirSync(siteSubdir, { recursive: true });
    fs.writeFileSync(path.join(projectRoot, "README.md"), "# loadout\n");
    fs.mkdirSync(path.join(siteSubdir, ".vercel"), { recursive: true });
    expectBoth(siteSubdir, "loadout");
  });

  test("two-tier: vendored sub-repo with .git wins over parent README (strong > weak)", () => {
    const projectRoot = path.join(tmp, "loadout");
    const subRepo = path.join(projectRoot, "starter-pack");
    fs.mkdirSync(subRepo, { recursive: true });
    fs.writeFileSync(path.join(projectRoot, "README.md"), "# loadout\n");
    fs.mkdirSync(path.join(subRepo, ".git"), { recursive: true });
    expectBoth(subRepo, "starter-pack");
  });

  test("two-tier: outermost weak wins when no strong marker exists on the chain", () => {
    const projectRoot = path.join(tmp, "loadout");
    const subdir = path.join(projectRoot, "docs");
    fs.mkdirSync(subdir, { recursive: true });
    fs.writeFileSync(path.join(projectRoot, "README.md"), "# loadout\n");
    fs.writeFileSync(path.join(subdir, "README.md"), "# docs\n");
    expectBoth(subdir, "loadout");
  });

  test("nested repo: outermost .git wins — nested/vendored repos don't split stores", () => {
    // THE bug this port fixes: the old native path asked the INNERMOST repo's
    // remote. bin/gstack-slug resolves the OUTERMOST strong marker instead.
    const outer = path.join(tmp, "outer-project");
    const inner = path.join(outer, "vendor", "inner-lib");
    fs.mkdirSync(inner, { recursive: true });
    spawnSync("git", ["init", "-q", outer]);
    spawnSync("git", ["-C", outer, "remote", "add", "origin", "git@github.com:acme/outer.git"]);
    spawnSync("git", ["init", "-q", inner]);
    spawnSync("git", ["-C", inner, "remote", "add", "origin", "git@github.com:vendor/inner.git"]);
    expectBoth(inner, "acme-outer");
  });

  test("LIVE BUG SHAPE: a stray empty .git ancestor no longer degrades the slug (remote-first)", () => {
    // The exact 2026-08-17 reproduction: an ancestor dir with an empty .git
    // (not a valid repo, no origin) above a canonical-remote repo. The
    // pre-remote-first native path resolved PROJECT_ROOT to the stray marker
    // ancestor, found no origin THERE, and degraded to its basename — filing
    // every repo under it into one shared ~/.gstack/projects/<basename>/.
    const strayHome = path.join(tmp, "strayhome");
    fs.mkdirSync(path.join(strayHome, ".git"), { recursive: true }); // empty — invalid repo
    const repo = path.join(strayHome, "work", "repo");
    fs.mkdirSync(repo, { recursive: true });
    spawnSync("git", ["init", "-q", repo]);
    spawnSync("git", ["-C", repo, "remote", "add", "origin", "https://github.com/garrytan/gstack"]);
    expectBoth(repo, "garrytan-gstack");
    expect(slugFromEnvironment(nativeHome(), repo)).not.toBe("strayhome");
  });

  test("nested repos under a stray marker: a no-remote outer cannot shadow an inner remote", () => {
    // Outermost REMOTE-bearing repo wins — an outer repo whose origin does
    // not resolve is skipped by the remote walk, so the inner remote-bearing
    // repo carries identity (parity with bin/gstack-slug's _outermost_remote_repo).
    const outer = path.join(tmp, "outer-plain");
    const inner = path.join(outer, "vendor", "inner-lib");
    fs.mkdirSync(inner, { recursive: true });
    spawnSync("git", ["init", "-q", outer]); // no origin — marker-only repo
    spawnSync("git", ["init", "-q", inner]);
    spawnSync("git", ["-C", inner, "remote", "add", "origin", "git@github.com:vendor/inner.git"]);
    expectBoth(inner, "vendor-inner");
  });

  test("degraded-ancestor cache self-heals: the pre-remote-first cached value is rewritten", () => {
    // Pre-fix, the resolver cached basename(PROJECT_ROOT) for the stray
    // marker ancestor. cached == the marker root's basename while a
    // remote-bearing repo BELOW it exists → recompute + heal the cache.
    const strayHome = path.join(tmp, "strayhome");
    fs.mkdirSync(path.join(strayHome, ".git"), { recursive: true });
    const repo = path.join(strayHome, "git", "proj");
    fs.mkdirSync(repo, { recursive: true });
    spawnSync("git", ["init", "-q", repo]);
    spawnSync("git", ["-C", repo, "remote", "add", "origin", "https://github.com/garrytan/gstack"]);

    const cacheDir = path.join(nativeHome(), "slug-cache");
    fs.mkdirSync(cacheDir, { recursive: true });
    const cacheFile = path.join(cacheDir, toMsysPath(repo).replace(/\//g, "_"));
    fs.writeFileSync(cacheFile, "strayhome"); // the degraded value the old resolver cached

    expect(slugFromEnvironment(nativeHome(), repo)).toBe("garrytan-gstack");
    // The cache file itself must have been overwritten (self-healing).
    expect(fs.readFileSync(cacheFile, "utf-8")).toBe("garrytan-gstack");
  });

  test("package.json wrapper root (no .git): sticky basename slug is PRESERVED — heal is stray-repo-shape only", () => {
    // Legit #2212 shape: a monorepo wrapper anchored by package.json used
    // gstack before an inner dir grew a remote-bearing repo. The degraded-
    // ancestor heal must NOT fire — it is restricted to marker roots anchored
    // by a .git entry whose origin does NOT resolve (the live-bug shape).
    const wrapper = path.join(tmp, "wrapperproj");
    const inner = path.join(wrapper, "apps", "web");
    fs.mkdirSync(inner, { recursive: true });
    fs.writeFileSync(path.join(wrapper, "package.json"), '{"name":"wrapper"}\n');
    spawnSync("git", ["init", "-q", inner]);
    spawnSync("git", ["-C", inner, "remote", "add", "origin", "https://github.com/acme/web.git"]);

    const cacheDir = path.join(nativeHome(), "slug-cache");
    fs.mkdirSync(cacheDir, { recursive: true });
    const cacheFile = path.join(cacheDir, toMsysPath(inner).replace(/\//g, "_"));
    fs.writeFileSync(cacheFile, "wrapperproj"); // legit sticky identity

    expect(slugFromEnvironment(nativeHome(), inner)).toBe("wrapperproj"); // NOT healed to acme-web
    expect(fs.readFileSync(cacheFile, "utf-8")).toBe("wrapperproj");

    // The bash implementation agrees on the same fixture (own home, seeded cache).
    if (HAS_BASH) {
      const bashCacheDir = path.join(tmp, "bash-home", ".gstack", "slug-cache");
      fs.mkdirSync(bashCacheDir, { recursive: true });
      fs.writeFileSync(path.join(bashCacheDir, toMsysPath(inner).replace(/\//g, "_")), "wrapperproj");
      expect(bashSlug(inner)).toBe("wrapperproj");
    }
  });

  test("sticky identity preserved (#2212): a remote adopted AT the marker root is NOT healed", () => {
    // Legit sticky shape: the repo that adopted the remote IS the marker root
    // (remote root == project root), so the degraded-ancestor heal must not
    // fire even though cached == basename(project root).
    const repo = path.join(tmp, "stickyproj");
    fs.mkdirSync(repo, { recursive: true });
    spawnSync("git", ["init", "-q", repo]);
    spawnSync("git", ["-C", repo, "remote", "add", "origin", "https://github.com/x/y.git"]);

    const cacheDir = path.join(nativeHome(), "slug-cache");
    fs.mkdirSync(cacheDir, { recursive: true });
    const cacheFile = path.join(cacheDir, toMsysPath(repo).replace(/\//g, "_"));
    fs.writeFileSync(cacheFile, "stickyproj"); // pre-origin basename identity

    expect(slugFromEnvironment(nativeHome(), repo)).toBe("stickyproj");
    expect(fs.readFileSync(cacheFile, "utf-8")).toBe("stickyproj");
  });

  test('hostile origin `url = ..` never becomes a dot slug — basename fallback (dot-only guard)', () => {
    // git accepts `..` as a remote URL. Unchecked, the derived slug would be
    // ".." — path traversal one level above ~/.gstack/projects/. Both
    // implementations must reject it and fall through to the basename.
    const repo = path.join(tmp, "dotty");
    fs.mkdirSync(repo, { recursive: true });
    spawnSync("git", ["init", "-q", repo]);
    spawnSync("git", ["-C", repo, "remote", "add", "origin", ".."]);
    expectBoth(repo, "dotty");
  });

  test("GSTACK_PROJECT_SLUG env override beats every other resolution path, never cached", () => {
    const projectRoot = path.join(tmp, "loadout");
    const siteSubdir = path.join(projectRoot, "site");
    fs.mkdirSync(path.join(projectRoot, ".git"), { recursive: true });
    fs.mkdirSync(siteSubdir, { recursive: true });

    process.env.GSTACK_PROJECT_SLUG = "custom-override";
    try {
      expect(slugFromEnvironment(nativeHome(), siteSubdir)).toBe("custom-override");
      if (HAS_BASH) {
        expect(bashSlug(siteSubdir, { GSTACK_PROJECT_SLUG: "custom-override" })).toBe("custom-override");
      }
    } finally {
      delete process.env.GSTACK_PROJECT_SLUG;
    }
    // Per-invocation escape hatch, never a durable identity: no cache written.
    const cacheFile = path.join(nativeHome(), "slug-cache", toMsysPath(siteSubdir).replace(/\//g, "_"));
    expect(fs.existsSync(cacheFile)).toBe(false);
  });

  test("outermostProjectRoot terminates on hostile path forms (dirname fixed points)", () => {
    // Mirrors the windows-free-tests regression on the bash side: mixed-form
    // paths must hit the dirname fixed point, not loop. A hang here would trip
    // the suite timeout; reaching the assertions IS the pass.
    for (const hostile of ["C:/Users/nobody/project", ".", "//server/share/dir"]) {
      expect(typeof outermostProjectRoot(hostile)).toBe("string");
    }
  });
});
