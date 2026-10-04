/**
 * Regression (#2884): a slug segment that starts with a dot wedged ingest.
 *
 * gbrain's import walker prunes every path segment beginning with "." and a
 * page slug maps 1:1 onto its staged path, so a `.claude` project staged a
 * file gbrain never collected. The staged-vs-collected guard then refused the
 * batch, and the same pages re-staged and failed on every run.
 */
import { describe, it, expect, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawnSync } from "child_process";
import { disambiguateSlugs } from "../bin/gstack-memory-ingest";

const SCRIPT = join(import.meta.dir, "..", "bin", "gstack-memory-ingest.ts");

const page = (slug: string, source_path: string) => ({
  slug,
  source_path,
  rendered_body: "---\ntitle: x\n---\n\nbody",
  page_slug: slug,
  partial: false,
  type: "learning" as const,
  git_remote: undefined,
});

describe("regression #2884: dot-leading slug segments", () => {
  let home = "";
  afterEach(() => {
    if (home) rmSync(home, { recursive: true, force: true });
    home = "";
  });

  it("maps a slug recorded under the old dot filename to the normalized slug, not a duplicate", () => {
    const fresh = page("learnings/dot-claude/2026-09-01-learnings", "/state/projects/.claude/learnings.jsonl");
    disambiguateSlugs([fresh], {
      sessions: { "/state/projects/.claude/learnings.jsonl": { page_slug: "learnings/.claude/2026-09-01-learnings" } },
    });
    expect(fresh.slug).toBe("learnings/dot-claude/2026-09-01-learnings");
    expect(fresh.page_slug).toBe(fresh.slug);
  });

  it("stages a .claude project page where gbrain's walker collects it, so the batch lands", () => {
    home = mkdtempSync(join(tmpdir(), "gstack-dot-slug-"));
    const gstackHome = join(home, ".gstack");
    const bin = join(home, "bin");
    mkdirSync(join(gstackHome, "projects", ".claude"), { recursive: true });
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(gstackHome, "projects", ".claude", "learnings.jsonl"), '{"key":"a","insight":"b"}\n');
    // Fake gbrain that prunes dot-leading segments exactly like gbrain's walker.
    writeFileSync(join(bin, "gbrain"), `#!${process.execPath}
const { readdirSync } = require("fs");
const { join, relative } = require("path");
const args = process.argv.slice(2);
if (args[0] === "--help") { console.log("  import <dir>"); process.exit(0); }
if (args[0] !== "import") process.exit(1);
const files = [];
(function walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith(".")) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p); else if (e.name.endsWith(".md")) files.push(relative(args[1], p));
  }
})(args[1]);
console.log(JSON.stringify({ status: "success", imported: files.length, skipped: 0, errors: 0, total_files: files.length }));
`, { mode: 0o755 });
    const r = spawnSync(process.execPath, [SCRIPT, "--bulk", "--sources", "learning", "--quiet"], {
      env: { HOME: home, GSTACK_HOME: gstackHome, PATH: `${bin}:${process.env.PATH}` },
      encoding: "utf-8",
      timeout: 30_000,
    });
    expect(r.stderr).not.toContain("Refusing to advance state");
    expect(r.status).toBe(0);
    const state = JSON.parse(readFileSync(join(gstackHome, ".transcript-ingest-state.json"), "utf-8"));
    const entry = state.sessions[join(gstackHome, "projects", ".claude", "learnings.jsonl")];
    expect(entry.page_slug.startsWith("learnings/dot-claude/")).toBe(true);
    expect(existsSync(join(gstackHome, ".staging-ingest"))).toBe(false);
  });
});
