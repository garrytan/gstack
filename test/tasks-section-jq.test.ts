/**
 * Regression pin for #2018: /autoplan Phase 4's task aggregator emitted zero
 * tasks on every run, forever, for everyone.
 *
 * Root cause: the branch+commit filter in scripts/resolvers/tasks-section.ts
 * piped to the split commit array and THEN referenced `.commit` —
 *
 *   select(.branch == $branch and ($commits | split("|") | index(.commit) != null))
 *
 * In jq, the pipe rebinds the context, so `.commit` was evaluated against the
 * split ARRAY ("Cannot index array with string \"commit\""), every input line
 * errored, stderr went to /dev/null, `|| true` swallowed the exit code, and
 * the aggregate was empty. A dead feature indistinguishable from "no tasks".
 *
 * These tests run the ACTUAL jq program extracted from the resolver source
 * against fixture JSONL, so they were RED against the broken filter and stay
 * red if anyone reintroduces a context-rebinding shape.
 */

import { describe, it, expect } from "bun:test";
import { execFileSync } from "child_process";
import { readFileSync } from "fs";
import { join } from "path";

const SOURCE_PATH = join(import.meta.dir, "..", "scripts", "resolvers", "tasks-section.ts");

/**
 * Extract the emitted jq filter program from the resolver source. The
 * resolver builds bash inside a TS template literal, so `\\` in source is a
 * bash line-continuation `\` — strip it when unescaping. We match the
 * single-quoted jq program on the line that filters by $branch + $commits.
 */
function extractBranchCommitFilter(): string {
  const src = readFileSync(SOURCE_PATH, "utf-8");
  const m = src.match(/'([^']*select\(\.branch == \$branch[^']*)'/);
  if (!m) throw new Error("branch+commit jq filter not found in tasks-section.ts");
  return m[1].replace(/\\\\/g, "\\");
}

function runJq(program: string, inputLines: string[], branch: string, commits: string): string[] {
  const out = execFileSync(
    "jq",
    ["-c", "--arg", "branch", branch, "--arg", "commits", commits, program],
    { input: inputLines.join("\n"), encoding: "utf-8" },
  );
  return out.split("\n").filter(Boolean);
}

const RECORD = (branch: string, commit: string) =>
  JSON.stringify({
    phase: "ceo-review",
    run_id: "20260814T000000Z-1",
    branch,
    commit,
    id: "T1",
    priority: "P1",
    component: "demo",
    files: ["a.ts"],
    effort_human: "~1h",
    effort_cc: "~5min",
    title: "demo task",
    source_finding: "demo finding",
  });

describe("tasks-section jq filter (#2018)", () => {
  it("matches a record whose branch and commit are in the window", () => {
    const program = extractBranchCommitFilter();
    const matched = runJq(
      program,
      [RECORD("feature/x", "abc123")],
      "feature/x",
      "abc123|def456",
    );
    // The broken filter returned [] here (every line errored) — the exact
    // #2018 symptom: reviews produced tasks, the aggregate table showed none.
    expect(matched).toHaveLength(1);
    expect(JSON.parse(matched[0]).id).toBe("T1");
  });

  it("filters out other branches and out-of-window commits", () => {
    const program = extractBranchCommitFilter();
    const matched = runJq(
      program,
      [
        RECORD("feature/x", "abc123"),
        RECORD("other-branch", "abc123"),
        RECORD("feature/x", "zzz999"),
      ],
      "feature/x",
      "abc123|def456",
    );
    expect(matched).toHaveLength(1);
  });

  it("errors on no input line at all rather than fabricating output", () => {
    const program = extractBranchCommitFilter();
    expect(runJq(program, [], "feature/x", "abc123")).toHaveLength(0);
  });

  it("source does not reference .commit after a context-rebinding pipe", () => {
    const src = readFileSync(SOURCE_PATH, "utf-8");
    // The bug shape: split("|") piped, then a bare `.commit` in the new array
    // context. Binding first (`.commit as $c`) is the required form.
    expect(src).not.toMatch(/split\("\|"\)\s*\|\s*index\(\.commit\)/);
  });
});
