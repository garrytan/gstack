/**
 * Regression pin: `gstack-memory-ingest` must pass `--include-gitignored` to
 * `gbrain import`.
 *
 * gstack-artifacts-init writes an ignore-everything `.gitignore` (a bare `*`,
 * headed "Do not edit") at the root of `~/.gstack`. The memory ingest stages
 * pages into `~/.gstack/.staging-ingest-<pid>-<ts>/`, which is INSIDE that
 * repo, and gbrain's markdown collector honours .gitignore. So the collector
 * walks the staging dir, matches every file against `*`, and collects zero.
 *
 * The failure is silent: `gbrain import` exits 0 having imported nothing,
 * while the ingest still prints `written: N` from the STAGED count rather
 * than the imported count. A run that indexes nothing is indistinguishable
 * from a healthy one, and the memory corpus quietly stops growing.
 *
 * Two tests here:
 *  1. Source pin (same shape as memory-ingest-no-put_page.test.ts): the flag
 *     is present in active code, so removing it trips the build.
 *  2. Behavioural proof of the underlying collision, using git's own ignore
 *     machinery. No gbrain and no network required.
 */

import { describe, it, expect } from "bun:test";
import { execFileSync } from "child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync, realpathSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { readFileSync } from "fs";

const SOURCE_PATH = join(import.meta.dir, "..", "bin", "gstack-memory-ingest.ts");

/** Strip comments so the pin only inspects executable code. */
function stripComments(src: string): string {
  const noBlock = src.replace(/\/\*[\s\S]*?\*\//g, "");
  return noBlock.replace(/\/\/[^\n]*/g, "");
}

describe("gstack-memory-ingest: gbrain import must not be filtered by .gitignore", () => {
  it("passes --include-gitignored in active code", () => {
    const stripped = stripComments(readFileSync(SOURCE_PATH, "utf-8"));
    expect(stripped).toContain("--include-gitignored");
  });

  it("keeps the flag on the same import invocation as the staging dir", () => {
    const stripped = stripComments(readFileSync(SOURCE_PATH, "utf-8"));
    // Match the spawn call's argument array and assert both the subcommand
    // and the flag live in it, so the flag can't drift onto another call.
    // [\s\S]*? bridges the conditional-spread's nested brackets (main's
    // capability-probed --include-gitignored merged with our baseEnv defense).
    const call = stripped.match(/spawnGbrainAsync\(\s*\[[\s\S]*?"import"[\s\S]*?\]/s);
    expect(call).not.toBeNull();
    expect(call![0]).toContain("--include-gitignored");
  });

  it("sets a realpath'd GIT_CEILING_DIRECTORIES on the import child (defense-in-depth)", () => {
    const stripped = stripComments(readFileSync(SOURCE_PATH, "utf-8"));
    // Second #2144 layer: the ceiling env must be built from the staging
    // dir's REAL parent path and merged into the spawn's baseEnv, so a
    // git-enumerating collector fails out of the git fast path even when
    // the flag's semantics drift, and symlinked staging paths still match.
    expect(stripped).toContain("GIT_CEILING_DIRECTORIES");
    expect(stripped).toMatch(/realpathSync\(dirname\(stagingDir\)\)/);
    const call = stripped.match(/spawnGbrainAsync\(\s*\[[\s\S]*?"import"[\s\S]*?\]\s*,\s*\{\s*baseEnv\s*\}/s);
    expect(call).not.toBeNull();
  });

  it("proves the ceiling stops git discovery from the staging dir — including through a symlink", () => {
    const dir = mkdtempSync(join(tmpdir(), "gstack-ingest-ceiling-"));
    try {
      const git = (args: string[], cwd: string, env?: NodeJS.ProcessEnv) =>
        execFileSync("git", args, {
          timeout: 30_000,
          cwd,
          encoding: "utf-8",
          env: { ...process.env, ...env },
        });
      // ~/.gstack shape: a git repo whose root ignores everything, with the
      // staging dir as a direct child.
      const home = join(dir, "gstack-home");
      mkdirSync(home, { recursive: true });
      git(["init", "-q", "."], home);
      writeFileSync(join(home, ".gitignore"), "*\n", "utf-8");
      const staging = join(home, ".staging-ingest-12345-1700000000000");
      mkdirSync(staging, { recursive: true });

      // Without a ceiling: discovery from the staging dir finds the repo —
      // this is the git fast path that collects zero files.
      const found = git(["rev-parse", "--show-toplevel"], staging).trim();
      expect(realpathSync(found)).toBe(realpathSync(home));

      // With the ceiling at the staging dir's REAL parent: discovery fails,
      // which is exactly what pushes a collector onto its plain FS walk.
      const ceiling = realpathSync(home);
      expect(() =>
        git(["rev-parse", "--show-toplevel"], staging, { GIT_CEILING_DIRECTORIES: ceiling }),
      ).toThrow();

      // Symlink variant (the OV4 trap): reach the same staging dir through a
      // symlinked path. A realpath'd ceiling still stops discovery.
      const linked = join(dir, "linked-home");
      symlinkSync(home, linked);
      const stagingViaLink = join(linked, ".staging-ingest-12345-1700000000000");
      expect(() =>
        git(["rev-parse", "--show-toplevel"], stagingViaLink, {
          GIT_CEILING_DIRECTORIES: ceiling,
        }),
      ).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("demonstrates the collision: an ignore-everything root hides staged pages", () => {
    const dir = mkdtempSync(join(tmpdir(), "gstack-ingest-gitignore-"));
    try {
      const git = (...args: string[]) =>
        execFileSync("git", args, { timeout: 30_000, cwd: dir, encoding: "utf-8" });
      git("init", "-q", ".");

      const staging = join(dir, ".staging-ingest-12345-1700000000000", "learnings");
      mkdirSync(staging, { recursive: true });
      writeFileSync(join(staging, "page.md"), "# a staged page\n", "utf-8");

      // Exactly what gstack-artifacts-init writes at the root of ~/.gstack.
      writeFileSync(join(dir, ".gitignore"), "*\n", "utf-8");

      // `git ls-files --others --exclude-standard` is the same view a
      // gitignore-honouring collector takes: untracked and not ignored.
      const collectable = git("ls-files", "--others", "--exclude-standard")
        .split("\n")
        .filter(Boolean);

      // The staged page is invisible. This is the silent data loss.
      expect(collectable).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
