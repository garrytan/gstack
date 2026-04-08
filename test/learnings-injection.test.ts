import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import path from "path";

const SCRIPT = path.join(import.meta.dir, "..", "bin", "gstack-learnings-search");

describe("gstack-learnings-search injection prevention", () => {
  const script = readFileSync(SCRIPT, "utf-8");

  test("no shell interpolation inside bun -e string", () => {
    // Extract the bun -e block (everything between `bun -e "` and the closing `"`)
    const bunBlock = script.slice(script.indexOf('bun -e "'));

    // Should NOT contain ${VAR} patterns (shell interpolation)
    // These are RCE vectors: a malicious learnings entry with '; rm -rf / ;' in the
    // query field would execute arbitrary commands via shell interpolation.
    const shellInterpolations = bunBlock.match(/'\$\{[A-Z_]+\}'/g) || [];
    const bareInterpolations = bunBlock.match(/\$\{[A-Z_]+\}/g) || [];

    // Filter out any that are inside process.env references (those are safe)
    const unsafeInterpolations = [
      ...shellInterpolations,
      ...bareInterpolations,
    ].filter((m) => !m.includes("process.env"));

    expect(unsafeInterpolations).toEqual([]);
  });

  test("uses process.env for all user-controlled values", () => {
    const bunBlock = script.slice(script.indexOf('bun -e "'));

    // Must use process.env for TYPE, QUERY, LIMIT, SLUG, CROSS_PROJECT
    expect(bunBlock).toContain("process.env.GSTACK_SEARCH_TYPE");
    expect(bunBlock).toContain("process.env.GSTACK_SEARCH_QUERY");
    expect(bunBlock).toContain("process.env.GSTACK_SEARCH_LIMIT");
    expect(bunBlock).toContain("process.env.GSTACK_SEARCH_SLUG");
    expect(bunBlock).toContain("process.env.GSTACK_SEARCH_CROSS");
  });

  test("env vars are set on the bun command line", () => {
    // The env vars must be passed to bun, not just set in the shell
    expect(script).toContain("GSTACK_SEARCH_TYPE=");
    expect(script).toContain("GSTACK_SEARCH_QUERY=");
    expect(script).toContain("GSTACK_SEARCH_LIMIT=");
    expect(script).toContain("GSTACK_SEARCH_SLUG=");
    expect(script).toContain("GSTACK_SEARCH_CROSS=");
  });
});
