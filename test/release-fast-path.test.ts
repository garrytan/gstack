import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");

describe("release fast path", () => {
  test("ship keeps review repairs inside one bounded invocation", () => {
    const ship = read("ship/SKILL.md.tmpl");
    const review = read("ship/sections/review-army.md.tmpl");

    expect(ship).toContain("bounded transaction");
    expect(ship).toContain("Allow at most two repair rounds");
    expect(review).toContain("continue in this invocation");
    expect(review).not.toContain("tell the user to run `/ship` again");
  });

  test("ship discovers test commands and preserves normal concurrency", () => {
    const tests = read("ship/sections/tests.md.tmpl");

    expect(tests).toContain("APPLICABLE_TEST_COMMANDS");
    expect(tests).toContain("Never force serial workers");
    expect(tests).toContain("retry that failing command once");
  });

  test("ship refreshes the base before versioning and before push", () => {
    const ship = read("ship/SKILL.md.tmpl");

    expect(ship).toContain("Final base freshness gate");
    expect(ship).toContain("Before credentials or push, fetch the base one last time");
  });

  test("land reuses exact-head CI and auto-continues only when fully green", () => {
    const land = read("land-and-deploy/SKILL.md.tmpl");

    expect(land).toContain("PR_HEAD_SHA_BEFORE");
    expect(land).toContain("PR_HEAD_SHA_AFTER");
    expect(land).toContain("PR_HEAD_SHA_BEFORE == PR_HEAD_SHA_AFTER");
    expect(land).toContain("exact PR head being assessed");
    expect(land).toContain("If there are zero warnings and zero blockers");
    expect(land).toMatch(/continue to\s+Step 4 automatically/);
  });

  test("the fast release contract is documented", () => {
    const docs = read("docs/howto-fast-release-workflow.md");

    expect(docs).toContain("## What runs once");
    expect(docs).toContain("## What `/land-and-deploy` reuses");
    expect(docs).toContain("## Evidence rules");
  });

  test("Codex uses on-demand ship sections instead of a monolith", () => {
    const resolver = read("scripts/resolvers/sections.ts");
    const generator = read("scripts/gen-skill-docs.ts");

    expect(resolver).toContain("ctx.host === 'claude' || ctx.host === 'codex'");
    expect(resolver).toContain("${ctx.paths.skillRoot}/../gstack-${ctx.skillName}/sections");
    expect(generator).toContain("currentHost === 'claude' || currentHost === 'codex'");
  });
});
