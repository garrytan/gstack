import { describe, test, expect, beforeAll } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { spawnSync } from "child_process";

// Regression test for issue #2018: the autoplan Phase 4 aggregator's
// branch+commit filter used `index(.commit)` INSIDE a `$commits | split("|")`
// pipe, where the input is the split array, so jq tried to index an array with
// the string "commit" and errored. The error was swallowed by `2>/dev/null`,
// so every aggregation silently returned zero tasks.
//
// We extract the real `select(...)` filter from the generated autoplan/SKILL.md
// and run it through jq so this test tracks whatever actually ships, not a copy.

const SKILL = join(import.meta.dir, "..", "autoplan", "SKILL.md");

function hasJq(): boolean {
  return spawnSync("jq", ["--version"], { encoding: "utf-8" }).status === 0;
}

function extractSelectFilter(): string {
  const text = readFileSync(SKILL, "utf-8");
  // The shipped line looks like:
  //   'select(.branch == $branch and (.commit as $c | ...))' \
  const m = text.match(/'(select\(\.branch == \$branch and [^']*\))'/);
  if (!m) throw new Error("could not find branch+commit select filter in autoplan/SKILL.md");
  return m[1];
}

// Run the extracted filter over one JSONL record, returning jq's result.
function runFilter(filter: string, record: object, branch: string, commits: string) {
  return spawnSync(
    "jq",
    ["-c", "--arg", "branch", branch, "--arg", "commits", commits, filter],
    { input: JSON.stringify(record), encoding: "utf-8", timeout: 10000 }
  );
}

describe("autoplan tasks aggregator branch+commit filter (issue #2018)", () => {
  let filter: string;

  beforeAll(() => {
    filter = extractSelectFilter();
  });

  test("filter does not reference the buggy bare index(.commit)", () => {
    // The fix binds the record's commit to a variable first; the regression was
    // an unbound `.commit` evaluated against the split array.
    expect(filter).not.toContain("index(.commit)");
    expect(filter).toContain("as $c");
  });

  test("matching branch + commit is selected (no jq error)", () => {
    const r = runFilter(
      filter,
      { branch: "dev", commit: "abc123", phase: "ceo-review" },
      "dev",
      "abc123|def456"
    );
    expect(r.status).toBe(0);
    expect(r.stderr).toBe("");
    expect(r.stdout.trim()).not.toBe("");
    expect(JSON.parse(r.stdout).commit).toBe("abc123");
  });

  test("non-matching commit is excluded (no jq error)", () => {
    const r = runFilter(
      filter,
      { branch: "dev", commit: "zzz999", phase: "ceo-review" },
      "dev",
      "abc123|def456"
    );
    expect(r.status).toBe(0);
    expect(r.stderr).toBe("");
    expect(r.stdout.trim()).toBe("");
  });

  test("wrong branch is excluded (no jq error)", () => {
    const r = runFilter(
      filter,
      { branch: "other", commit: "abc123", phase: "ceo-review" },
      "dev",
      "abc123|def456"
    );
    expect(r.status).toBe(0);
    expect(r.stderr).toBe("");
    expect(r.stdout.trim()).toBe("");
  });

  test("record missing commit field does not error, just excludes", () => {
    const r = runFilter(
      filter,
      { branch: "dev", phase: "ceo-review" },
      "dev",
      "abc123|def456"
    );
    expect(r.status).toBe(0);
    expect(r.stderr).toBe("");
    expect(r.stdout.trim()).toBe("");
  });
});
