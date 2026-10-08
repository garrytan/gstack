/**
 * redact-doc resolver tests (T3/T16). The taxonomy table is generated from
 * lib/redact-patterns (single source of truth) and must contain every pattern
 * id + the recognizable credential prefixes. The invocation block must encode
 * the scan-at-sink contract (temp file → scan → same file), the exit-code
 * branches, the which-bun probe, and the guardrail framing.
 */
import { describe, test, expect } from "bun:test";
import { spawnSync } from "child_process";
import * as path from "path";
import {
  generateRedactInvocationBlock,
} from "../scripts/resolvers/redact-doc";
import { HOST_PATHS } from "../scripts/resolvers/types";
import { PATTERNS } from "../lib/redact-patterns";

const ctx = {
  skillName: "spec",
  tmplPath: "",
  host: "claude" as const,
  paths: HOST_PATHS["claude"],
};


describe("REDACT_INVOCATION_BLOCK", () => {
  test("scan-at-sink: agent-written private file → scan that file → exact bytes", () => {
    const block = generateRedactInvocationBlock(ctx, ["pre-archive"]);
    // CEO-12: the bytes come from the file the agent wrote (created by the
    // shared mktemp free-text block), never from a heredoc.
    expect(block).toContain('/.gstack/tmp/<redact-file-name>"');
    expect(block).not.toContain("<<");
    expect(block).toContain("--from-file");
    expect(block).toMatch(/exact bytes/i);
  });

  test("encodes exit-code branches 3/2/0", () => {
    const block = generateRedactInvocationBlock(ctx, ["pre-codex"]);
    expect(block).toContain("Exit 3 (HIGH)");
    expect(block).toContain("Exit 2 (MEDIUM)");
    expect(block).toContain("Exit 0 (clean)");
  });

  test("resolves visibility config → gh → glab → unknown", () => {
    const block = generateRedactInvocationBlock(ctx, ["pre-archive"]);
    expect(block).toContain("redact_repo_visibility");
    expect(block).toContain("gh repo view --json visibility");
    expect(block).toContain("glab repo view");
  });

  test("includes a which-bun probe", () => {
    expect(generateRedactInvocationBlock(ctx, ["pre-archive"])).toContain("command -v bun");
  });

  test("HIGH has no skip flag; framed as guardrail not enforcement", () => {
    const block = generateRedactInvocationBlock(ctx, ["pre-archive"]);
    expect(block).toMatch(/no skip flag for HIGH/i);
    expect(block).toMatch(/guardrail, not airtight enforcement/i);
  });

  test("PII subset offers auto-redact; non-PII MEDIUM does not", () => {
    const block = generateRedactInvocationBlock(ctx, ["pre-commit"]);
    expect(block).toContain("--auto-redact");
    expect(block).toContain("Proceed (acknowledged)");
  });

  test("sink label drives the prose noun/verb", () => {
    expect(generateRedactInvocationBlock(ctx, ["pre-commit"])).toContain("commit");
    expect(generateRedactInvocationBlock(ctx, ["pre-archive"])).toContain("write the archive");
  });

  test("unknown sink label falls back without throwing", () => {
    expect(() => generateRedactInvocationBlock(ctx, ["bogus-sink"])).not.toThrow();
  });
});

describe("PR and issue sites carry no separate scan (CEO-19)", () => {
  // gstack-post scans the exact bytes it posts; a second scan at a PR or issue
  // site would ask the user twice and could drift from what is sent.
  test("no template renders a PR, MR or issue sink", () => {
    const r = spawnSync("git", ["grep", "-n", "-E", "REDACT_INVOCATION_BLOCK:pre-(issue|pr-)", "--", "*.tmpl"], {
      cwd: path.resolve(import.meta.dir, ".."), encoding: "utf8", timeout: 30_000,
    });
    expect(r.stdout).toBe("");
    expect(r.status).toBe(1);
  });
});
