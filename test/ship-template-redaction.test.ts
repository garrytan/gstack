/**
 * /ship redaction wiring (T5/T11, CEO-19). The PR body + title are published
 * only through gstack-post, which scans the exact bytes it sends on create AND
 * edit; tool output goes in attributed fences so example credentials
 * WARN-degrade instead of blocking.
 */
import { describe, test, expect } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import { scan } from "../lib/redact-engine";

const ROOT = path.resolve(import.meta.dir, "..");
// Carved (v2 plan T9): ship is a skeleton template + sections/*.md.tmpl. The
// PR-body redaction wiring moved into sections/pr-body.md.tmpl, so assert against
// the union of the skeleton template and its section templates.
function readShipTemplateUnion(): string {
  let t = fs.readFileSync(path.join(ROOT, "ship", "SKILL.md.tmpl"), "utf-8");
  const secDir = path.join(ROOT, "ship", "sections");
  if (fs.existsSync(secDir)) {
    for (const f of fs.readdirSync(secDir).sort()) {
      if (f.endsWith(".md.tmpl")) t += "\n" + fs.readFileSync(path.join(secDir, f), "utf-8");
    }
  }
  return t;
}
const TMPL = readShipTemplateUnion();

describe("/ship redaction wiring", () => {
  // CEO-19: gstack-post owns the scan of the exact title and body bytes it
  // sends (test/gstack-post*.test.ts, test/ship-publication-gates.test.ts), so
  // /ship publishes only through it and never calls gh/glab with text itself.
  test("creates and edits only through gstack-post, from the composed body file and the title file", () => {
    expect(TMPL).toContain('gstack-post pr-create --base <base> --title-file "$TITLE_FILE" --body-file "${PR_BODY_FILE:?restore the composed body path}"');
    expect(TMPL).toContain('gstack-post pr-body <pr-number> --body-file "${PR_BODY_FILE:?restore the composed body path}"');
    expect(TMPL).toContain('gstack-post pr-title <pr-number> --title-file "$TITLE_FILE"');
  });
  test("no gh/glab call carries a title or body, and no shell variable holds the title", () => {
    expect(TMPL).not.toMatch(/gh pr (?:create|edit)[^\n`]*--(?:title|body)/);
    expect(TMPL).not.toMatch(/glab mr (?:create|update)[^\n`]*(?:-t|-d) /);
    expect(TMPL).not.toMatch(/-f title=|-F body=@"\$PR_BODY_FILE"/);
    expect(TMPL).not.toContain("NEW_TITLE");
  });
  test("HIGH blocks the PR (exit 1), with no confirmation path", () => {
    expect(TMPL).toMatch(/\*\*1\*\* HIGH finding: BLOCKED — do not publish/);
  });
  test("MEDIUM needs the user's answer and the token printed for those bytes", () => {
    expect(TMPL).toContain("AskUserQuestion per\n  finding");
    expect(TMPL).toContain("`--confirm <confirm-token>`");
    expect(TMPL).toContain("any edit needs a new token");
  });
  test("instructs wrapping tool output in attributed fences (TENSION-3)", () => {
    expect(TMPL).toMatch(/tool-attributed fences/);
    expect(TMPL).toMatch(/codex-review/);
    expect(TMPL).toMatch(/greptile/);
  });
});

describe("tool-attributed fence behavior (engine contract /ship relies on)", () => {
  test("a doc-example credential inside a tool fence WARN-degrades, does not block", () => {
    const body = "## Codex review\n```codex-review\nflagged your_aws_key AKIAIOSFODNN7EXAMPLE\n```";
    const r = scan(body, { repoVisibility: "public" });
    expect(r.counts.HIGH).toBe(0);
  });
  test("a live-format credential inside a tool fence STILL blocks", () => {
    const body = "```codex-review\nleaked AKIA1234567890ABCDEF\n```";
    const r = scan(body, { repoVisibility: "public" });
    expect(r.counts.HIGH).toBe(1);
  });
  test("a credential in plain PR prose (no fence) blocks", () => {
    const body = "We hardcoded AKIA1234567890ABCDEF in the config";
    expect(scan(body, { repoVisibility: "public" }).counts.HIGH).toBe(1);
  });
});
