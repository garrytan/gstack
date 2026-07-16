/**
 * redact-doc resolver tests (T3/T16). The taxonomy table is generated from
 * lib/redact-patterns (single source of truth) and must contain every pattern
 * id + the recognizable credential prefixes. The invocation block must encode
 * the scan-at-sink contract (temp file → scan → same file), the exit-code
 * branches, the which-bun probe, and the guardrail framing.
 */
import { describe, test, expect } from "bun:test";
import {
  generateRedactTaxonomyTable,
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

describe("REDACT_TAXONOMY_TABLE", () => {
  const table = generateRedactTaxonomyTable(ctx);

  test("lists every pattern id from the engine (no drift)", () => {
    for (const p of PATTERNS) {
      expect(table).toContain(`\`${p.id}\``);
    }
  });

  test("contains the recognizable credential prefixes", () => {
    for (const s of ["AKIA", "ghp_", "sk-ant-", "sk-", "BEGIN"]) {
      expect(table).toContain(s);
    }
  });

  test("has all three tier sections", () => {
    expect(table).toContain("HIGH — genuinely-secret");
    expect(table).toContain("MEDIUM — PII");
    expect(table).toContain("LOW — surfaced");
  });

  test("documents the calibration rationale (publishable/AIza/JWT are MEDIUM)", () => {
    expect(table).toMatch(/cries wolf/);
    expect(table).toContain("pk_live_");
  });
});

describe("REDACT_INVOCATION_BLOCK", () => {
  test("scan-at-sink: temp file → scan that file → exact bytes", () => {
    const block = generateRedactInvocationBlock(ctx, ["pre-issue"]);
    expect(block).toContain("mktemp");
    expect(block).toContain("--from-file");
    expect(block).toMatch(/EXACT bytes/);
  });

  test("encodes exit-code branches 3/2/0", () => {
    const block = generateRedactInvocationBlock(ctx, ["pre-codex"]);
    expect(block).toContain("Exit 3 (HIGH)");
    expect(block).toContain("Exit 2 (MEDIUM)");
    expect(block).toContain("Exit 0 (clean)");
  });

  test("resolves visibility config → gh → glab → unknown", () => {
    const block = generateRedactInvocationBlock(ctx, ["pre-issue"]);
    expect(block).toContain("redact_repo_visibility");
    expect(block).toContain("gh repo view --json visibility");
    expect(block).toContain("glab repo view");
  });

  test("includes a which-bun probe", () => {
    expect(generateRedactInvocationBlock(ctx, ["pre-issue"])).toContain("command -v bun");
  });

  test("HIGH has no skip flag; framed as guardrail not enforcement", () => {
    const block = generateRedactInvocationBlock(ctx, ["pre-issue"]);
    expect(block).toMatch(/no skip flag for HIGH/i);
    expect(block).toMatch(/guardrail, not airtight enforcement/i);
  });

  test("PII subset offers auto-redact; non-PII MEDIUM does not", () => {
    const block = generateRedactInvocationBlock(ctx, ["pre-pr-body"]);
    expect(block).toContain("--auto-redact");
    expect(block).toContain("Proceed (acknowledged)");
  });

  test("sink label drives the prose noun/verb", () => {
    expect(generateRedactInvocationBlock(ctx, ["pre-commit"])).toContain("commit");
    expect(generateRedactInvocationBlock(ctx, ["pre-pr-title"])).toContain("PR title");
  });

  test("unknown sink label falls back without throwing", () => {
    expect(() => generateRedactInvocationBlock(ctx, ["bogus-sink"])).not.toThrow();
  });
});
