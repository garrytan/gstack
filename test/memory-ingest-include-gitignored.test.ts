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
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
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
    const call = stripped.match(/spawnGbrainAsync\(\s*\[[^\]]*"import"[^\]]*\]/s);
    expect(call).not.toBeNull();
    expect(call![0]).toContain("--include-gitignored");
  });

  it("demonstrates the collision: an ignore-everything root hides staged pages", () => {
    const dir = mkdtempSync(join(tmpdir(), "gstack-ingest-gitignore-"));
    try {
      const git = (...args: string[]) =>
        execFileSync("git", args, { cwd: dir, encoding: "utf-8" });
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
