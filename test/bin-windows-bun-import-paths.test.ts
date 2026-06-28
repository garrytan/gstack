/**
 * #1950 — Windows git-bash POSIX paths break `bun -e` module imports.
 *
 * Under git-bash, `pwd` yields /c/Users/... which Bun on Windows cannot
 * resolve as an ES module specifier. Any bash bin that interpolates
 * $SCRIPT_DIR into a `bun -e` import must normalize it via `cygpath -m`
 * first, or the bin exits 1 with "Cannot find module" — which, combined
 * with stderr swallowing, silently dropped every AI-logged learning.
 *
 * Two layers:
 *   1. Static invariant — every bash bin with a $SCRIPT_DIR bun-import
 *      interpolation carries the cygpath guard (catches future bins).
 *   2. Behavioral — gstack-learnings-log, invoked the way Windows CI
 *      invokes bash bins (spawnSync("bash", [path])), writes a learning
 *      and surfaces validation errors on stderr instead of swallowing
 *      them. This file is in the windows-free-tests workflow list, so the
 *      cygpath conversion is proven on the only platform where #1950
 *      exists.
 */

import { describe, it, expect } from "bun:test";
import { spawnSync } from "child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");
const BIN_DIR = join(ROOT, "bin");

const CYGPATH_GUARD = /cygpath/;
// A bun -e payload that imports through the interpolated $SCRIPT_DIR.
const BUN_IMPORT_INTERPOLATION = /bun -e "[^]*?from '\$SCRIPT_DIR\//;

function bashBins(): string[] {
  return readdirSync(BIN_DIR).filter((name) => {
    const p = join(BIN_DIR, name);
    if (!statSync(p).isFile()) return false;
    const head = readFileSync(p, "utf-8").slice(0, 64);
    return head.startsWith("#!") && head.includes("bash");
  });
}

describe("bin/ — Windows bun-import path guard (#1950)", () => {
  it("every bash bin that interpolates $SCRIPT_DIR into a bun -e import has the cygpath guard", () => {
    const offenders: string[] = [];
    for (const name of bashBins()) {
      const content = readFileSync(join(BIN_DIR, name), "utf-8");
      if (BUN_IMPORT_INTERPOLATION.test(content) && !CYGPATH_GUARD.test(content)) {
        offenders.push(name);
      }
    }
    expect(
      offenders,
      `bins interpolate $SCRIPT_DIR into a bun -e import without a cygpath guard ` +
        `(breaks on Windows git-bash, #1950): ${offenders.join(", ")}`,
    ).toEqual([]);
  });

  it("known-affected bins carry the guard explicitly", () => {
    for (const name of ["gstack-learnings-log", "gstack-question-log"]) {
      const content = readFileSync(join(BIN_DIR, name), "utf-8");
      expect(content).toContain("cygpath -m");
    }
  });
});

describe("gstack-learnings-log — behavioral (runs on Windows CI via git-bash)", () => {
  function runViaBash(input: string, gstackHome: string) {
    // spawnSync("bash", [path]) mirrors how git-bash users (and Windows CI)
    // execute the bin — Windows CreateProcess cannot parse shebangs.
    return spawnSync("bash", [join(BIN_DIR, "gstack-learnings-log"), input], {
      encoding: "utf-8",
      timeout: 20_000,
      cwd: ROOT,
      env: { ...process.env, GSTACK_HOME: gstackHome },
    });
  }

  it("writes a learning end-to-end (proves the bun import resolves on this platform)", () => {
    const tmp = mkdtempSync(join(tmpdir(), "gstack-win-learn-"));
    try {
      const r = runViaBash(
        JSON.stringify({
          skill: "test",
          type: "operational",
          key: "windows-path-check",
          insight: "cygpath guard keeps the bun import resolvable",
          confidence: 8,
          source: "observed",
        }),
        tmp,
      );
      expect(r.status).toBe(0);
      const projects = readdirSync(join(tmp, "projects"));
      expect(projects.length).toBeGreaterThan(0);
      const written = readFileSync(
        join(tmp, "projects", projects[0], "learnings.jsonl"),
        "utf-8",
      );
      expect(written).toContain("windows-path-check");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("surfaces validation errors on stderr instead of swallowing them", () => {
    const tmp = mkdtempSync(join(tmpdir(), "gstack-win-learn-"));
    try {
      const r = runViaBash(
        JSON.stringify({ skill: "test", type: "not-a-type", key: "k", insight: "x", confidence: 5 }),
        tmp,
      );
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain("invalid type");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
