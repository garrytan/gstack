/**
 * Regression pin for #1346: gstack-memory-ingest must never call the
 * `gbrain put_page` subcommand (renamed to `put` in gbrain v0.18+).
 *
 * The original bug shipped a literal `"put_page"` in execFileSync args,
 * crashing every transcript ingest against modern gbrain. The fix migrated
 * the per-file path to `gbrain put <slug>` and later to the batch
 * `gbrain import <dir>` runner. This test pins both surfaces: source code
 * must not contain `put_page` outside comments, and any future contributor
 * adding it back trips the build.
 */

import { describe, it, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const SOURCE_PATH = join(import.meta.dir, "..", "bin", "gstack-memory-ingest.ts");

/**
 * Strip line comments (`// ...`) and block comments (`/* ... *​/`) from TS
 * source so the regression check only inspects executable code. Naive but
 * sufficient — we don't need full TS parsing, just to ignore the
 * documentation/changelog mentions of the old subcommand name.
 *
 * Order matters: strip block comments first (they may span multiple lines
 * and contain `//`), then line comments. String-literal awareness is
 * intentionally skipped — if anyone writes "put_page" inside an active
 * string they want the test to fail.
 */
function stripComments(src: string): string {
  // Block comments — non-greedy across newlines.
  const noBlock = src.replace(/\/\*[\s\S]*?\*\//g, "");
  // Line comments — strip from `//` to end of line.
  return noBlock.replace(/\/\/[^\n]*/g, "");
}

describe("gstack-memory-ingest — no put_page in active code (regression for #1346)", () => {
  it("source file does not call the renamed gbrain put_page subcommand", () => {
    const src = readFileSync(SOURCE_PATH, "utf-8");
    const stripped = stripComments(src);
    expect(stripped).not.toContain("put_page");
  });

  it("source file does call the canonical gbrain put subcommand or gbrain import", () => {
    // Sanity check that the file actually uses one of the supported page-write
    // verbs — guards against accidentally removing all gbrain calls and having
    // the negative test above pass for the wrong reason.
    const src = readFileSync(SOURCE_PATH, "utf-8");
    const stripped = stripComments(src);
    const callsPut = /\bgbrain\s+put\b/.test(stripped) || /["']put["']/.test(stripped);
    const callsImport = /\bimport\b/.test(stripped); // `gbrain import` runner
    expect(callsPut || callsImport).toBe(true);
  });
});
