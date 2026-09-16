/**
 * Regression: a dot-leading slug segment permanently wedges memory ingest.
 *
 * gbrain's import walker prunes ANY path segment beginning with a dot
 * (isPathPruned, gbrain src/core/sync.ts). stagedRelPath() maps a page slug 1:1
 * onto its path inside the staging dir, so a slug like
 * `timelines/.claude/2026-09-03-timeline` staged a file gbrain never collected.
 * The staged-vs-collected reconciliation then mismatched and the run refused to
 * advance state — correctly, but that meant the SAME pages re-staged and failed
 * on EVERY subsequent run, so transcript ingest never recovered on its own.
 *
 * Reproduced in the wild with the project slug ".claude", which gstack mints
 * whenever a session runs with cwd ~/.claude.
 */
import { describe, it, expect } from "bun:test";
import {
  safeSlugSegment,
  stagedRelPath,
  buildArtifactPage,
} from "../bin/gstack-memory-ingest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

describe("safeSlugSegment", () => {
  it("rewrites a leading dot so gbrain's walker cannot prune the segment", () => {
    expect(safeSlugSegment(".claude")).toBe("dot-claude");
    expect(safeSlugSegment("..hidden")).toBe("dot-hidden");
  });

  it("leaves ordinary segments untouched", () => {
    expect(safeSlugSegment("claude")).toBe("claude");
    expect(safeSlugSegment("foo-bar")).toBe("foo-bar");
    expect(safeSlugSegment("_unattributed")).toBe("_unattributed");
    expect(safeSlugSegment("repo.with.dots")).toBe("repo.with.dots");
  });
});

describe("stagedRelPath", () => {
  it("stages an ordinary slug as <slug>.md", () => {
    expect(stagedRelPath("timelines/repo/2026-09-03-timeline")).toBe(
      "timelines/repo/2026-09-03-timeline.md",
    );
  });

  it("refuses a dot-leading segment rather than staging a file gbrain will prune", () => {
    // Defence in depth: disambiguateSlugs can re-pin a slug straight from
    // state, and the remote-http branch records page_slug without gbrain
    // reconciliation, so a slug minted before this fix could still arrive here.
    // Failing loudly beats a silent prune that wedges the next run.
    expect(() => stagedRelPath("timelines/.claude/2026-09-03-timeline")).toThrow(
      /dot-leading slug segment/,
    );
  });
});

describe("regression: dot-leading project slug survives artifact page build", () => {
  it("builds a collectible slug for a project dir named .claude", () => {
    const tmp = mkdtempSync(join(tmpdir(), "dot-slug-regression-"));
    try {
      const projDir = join(tmp, ".gstack", "projects", ".claude");
      mkdirSync(projDir, { recursive: true });
      const file = join(projDir, "timeline.jsonl");
      writeFileSync(
        file,
        JSON.stringify({ skill: "codex", event: "started", ts: "2026-09-03T04:04:24.378Z" }) + "\n",
      );

      const page = buildArtifactPage(file, "timeline");

      // The bug: slug was `timelines/.claude/...`, which gbrain silently pruned.
      expect(page.slug.split("/").some((seg) => seg.startsWith("."))).toBe(false);
      expect(page.slug).toContain("timelines/dot-claude/");
      // And the staged path must be derivable without throwing.
      expect(stagedRelPath(page.slug).endsWith(".md")).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
