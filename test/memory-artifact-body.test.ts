import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { ARTIFACT_BODY_MAX_CHARS, artifactBody } from "../lib/memory-artifact-body";

const rows = (n: number) => Array.from({ length: n }, (_, i) => JSON.stringify({ ts: `2026-11-${String(i).padStart(5, "0")}`, skill: "ship", event: "completed" })).join("\n") + "\n";

describe("artifactBody (#4362)", () => {
  test("a file within the cap is kept whole", () => {
    const raw = rows(10);
    expect(artifactBody("/h/.gstack/projects/p/timeline.jsonl", raw)).toBe(raw);
  });

  test("an oversized .jsonl log keeps its newest complete rows", () => {
    const raw = rows(5000);
    expect(raw.length).toBeGreaterThan(ARTIFACT_BODY_MAX_CHARS);
    const body = artifactBody("/h/.gstack/projects/p/timeline.jsonl", raw);
    expect(body.length).toBeLessThanOrEqual(ARTIFACT_BODY_MAX_CHARS);
    expect(raw.endsWith(body)).toBe(true);
    const kept = body.trimEnd().split("\n");
    for (const line of kept) expect(() => JSON.parse(line)).not.toThrow();
    expect(kept.at(-1)).toBe(raw.trimEnd().split("\n").at(-1));
  });

  test("a cut that lands on a row boundary keeps that whole row", () => {
    const raw = "a\nbb\ncc\n";
    expect(artifactBody("t.jsonl", raw, 6)).toBe("bb\ncc\n");
    expect(artifactBody("t.jsonl", raw, 7)).toBe("bb\ncc\n");
  });

  test("an oversized final .jsonl row never yields an empty body", () => {
    const raw = "a\n" + "x".repeat(ARTIFACT_BODY_MAX_CHARS + 10) + "\n";
    const body = artifactBody("t.jsonl", raw);
    expect(body.length).toBeGreaterThan(0);
    expect(body.length).toBeLessThanOrEqual(ARTIFACT_BODY_MAX_CHARS);
  });

  test("an oversized markdown file keeps its start, as before", () => {
    const raw = "# Plan\n" + "x".repeat(ARTIFACT_BODY_MAX_CHARS);
    expect(artifactBody("/h/.gstack/projects/p/ceo-plans/plan.md", raw)).toBe(raw.slice(0, ARTIFACT_BODY_MAX_CHARS));
  });

  test("buildArtifactPage builds its body with artifactBody", () => {
    const src = readFileSync(join(import.meta.dir, "..", "bin", "gstack-memory-ingest.ts"), "utf-8");
    const fn = src.slice(src.indexOf("function buildArtifactPage("), src.indexOf("// ── Writer"));
    expect(fn).toContain("const body = artifactBody(path, raw);");
  });
});
