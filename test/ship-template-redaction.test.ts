/**
 * /ship redaction wiring (T5/T11). The PR body + title are scanned at-sink before
 * create AND edit; tool output goes in attributed fences so example credentials
 * WARN-degrade instead of blocking; create/edit file from the scanned temp file.
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
  test("scans the PR body via the shared bin before create", () => {
    expect(TMPL).toContain("gstack-redact --from-file");
    expect(TMPL).toMatch(/Redaction scan \(PR body \+ title\)/);
  });
  test("creates from the scanned temp file (exact bytes)", () => {
    expect(TMPL).toContain('PROVIDER_PR_ACTION_ARGS=(create --base <base>)');
    expect(TMPL).toMatch(/gstack-effect-scope provider-pr[\s\S]{0,260}--body-file "\$PR_BODY_FILE"/);
    expect(TMPL).toContain('--assert-body-sha256 "$PR_BODY_SHA256"');
    expect(TMPL).not.toMatch(/^gh pr create\b/m);
  });
  test("edit path also scans before sending", () => {
    expect(TMPL).toContain('PROVIDER_PR_ACTION_ARGS=(update --pr "$PR_NUMBER")');
    expect(TMPL).toMatch(/gstack-effect-scope provider-pr[\s\S]{0,260}--body-file "\$PR_BODY_FILE"/);
    expect(TMPL).toContain('--assert-body-sha256 "$PR_BODY_SHA256"');
    expect(TMPL).toMatch(/same scan runs before the closed provider update path/i);
    expect(TMPL).not.toMatch(/^gh pr edit\b/m);
  });
  test("HIGH blocks the PR (exit 3), no skip", () => {
    expect(TMPL).toMatch(/BLOCKED — credential in PR body/);
  });
  test("instructs wrapping tool output in attributed fences (TENSION-3)", () => {
    expect(TMPL).toMatch(/tool-attributed fences/);
    expect(TMPL).toMatch(/codex-review/);
    expect(TMPL).toMatch(/greptile/);
  });
  test("scans the title too", () => {
    expect(TMPL).toContain('printf \'%s\' "$NEW_TITLE" | ~/.claude/skills/gstack/bin/gstack-redact');
    expect(TMPL).toContain('--title "$NEW_TITLE" --body-file "$PR_BODY_FILE"');
    expect(TMPL).toContain('PROVIDER_TITLE_ASSERTIONS');
    expect(TMPL).not.toMatch(/^gh pr (create|edit)\b/m);
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
