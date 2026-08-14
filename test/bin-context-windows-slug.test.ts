import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  toMsysPath,
  slugFromEnvironment,
  resolveSlug,
  NEEDS_NATIVE_SLUG_ON_WINDOWS,
} from "../lib/bin-context";

const ROOT = path.resolve(import.meta.dir, "..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf-8");

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gstack-slug-")); });
afterEach(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });

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
