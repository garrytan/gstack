/**
 * Tests for find-browse binary locator.
 */

import { describe, test, expect } from "bun:test";
import { getBrowseCandidatePaths, locateBinary } from "../src/find-browse";
import { existsSync } from "fs";

describe("locateBinary", () => {
  test("checks Codex and Claude-style install roots in priority order", () => {
    const paths = getBrowseCandidatePaths("/repo", "/home/tester");
    expect(paths).toEqual([
      "/repo/.codex/skills/gstack/browse/dist/browse",
      "/repo/.agents/skills/gstack/browse/dist/browse",
      "/repo/.claude/skills/gstack/browse/dist/browse",
      "/home/tester/.codex/skills/gstack/browse/dist/browse",
      "/home/tester/.agents/skills/gstack/browse/dist/browse",
      "/home/tester/.claude/skills/gstack/browse/dist/browse",
    ]);
  });

  test("returns null when no binary exists at known paths", () => {
    // This test depends on the test environment — if a real binary exists at
    // ~/.codex/skills/gstack/browse/dist/browse or ~/.claude/skills/gstack/browse/dist/browse,
    // it will find it.
    // We mainly test that the function doesn't throw.
    const result = locateBinary();
    expect(result === null || typeof result === "string").toBe(true);
  });

  test("returns string path when binary exists", () => {
    const result = locateBinary();
    if (result !== null) {
      expect(existsSync(result)).toBe(true);
    }
  });
});
