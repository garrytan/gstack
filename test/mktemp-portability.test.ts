/**
 * Regression pin for #2091: /codex was broken on every macOS install because
 * its mktemp templates carried a suffix after the X's ("codex-err-XXXXXX.txt").
 * BSD mktemp (macOS) requires the X's to be the trailing characters of the
 * template; with a suffix it fails ("mkstemp failed ... File exists"), the
 * temp file never exists, and the skill dies before Codex ever runs.
 *
 * GNU mktemp accepts a --suffix flag but ALSO rejects inline suffixes in the
 * template argument on BusyBox, so the portable form is: X's last, no suffix.
 *
 * This scans every .tmpl (the sources of truth — generated SKILL.md files
 * follow at regen time) for the broken shape.
 */

import { describe, it, expect } from "bun:test";
import { execFileSync } from "child_process";
import { readFileSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");

function trackedTmplFiles(): string[] {
  const out = execFileSync("git", ["ls-files", "*.tmpl", "**/*.tmpl"], {
    cwd: ROOT,
    encoding: "utf-8",
  });
  return out.split("\n").filter(Boolean);
}

describe("mktemp portability (#2091)", () => {
  it("no .tmpl file uses a mktemp template with characters after XXXXXX", () => {
    const offenders: string[] = [];
    for (const rel of trackedTmplFiles()) {
      const src = readFileSync(join(ROOT, rel), "utf-8");
      src.split("\n").forEach((line, i) => {
        // Broken shape: the X-run followed by a non-quote, non-whitespace,
        // non-closing character inside a mktemp invocation. X{6,} is greedy,
        // so longer X-runs (spec's XXXXXXXX) stay valid — only a genuine
        // suffix after the final X trips it.
        if (/mktemp[^\n]*X{6,}[^"'\s)X]/.test(line)) {
          offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });

  it("BSD-portable form actually works on this platform", () => {
    // Live sanity: the exact template shape the skills now emit.
    const tmp = process.env.TMPDIR || "/tmp";
    const created = execFileSync("mktemp", [`${tmp.replace(/\/$/, "")}/gstack-portability-XXXXXX`], {
      encoding: "utf-8",
    }).trim();
    expect(created.length).toBeGreaterThan(0);
    execFileSync("rm", ["-f", created]);
  });
});
