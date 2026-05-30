/**
 * /document-release + /document-generate redaction wiring (T6/T7).
 */
import { describe, test, expect } from "bun:test";
import * as fs from "fs";
import * as path from "path";

const ROOT = path.resolve(import.meta.dir, "..");
const RELEASE = fs.readFileSync(path.join(ROOT, "document-release", "SKILL.md.tmpl"), "utf-8");
const GENERATE = fs.readFileSync(path.join(ROOT, "document-generate", "SKILL.md.tmpl"), "utf-8");

describe("/document-release redaction", () => {
  test("scans the PR-body temp file before gh pr edit", () => {
    const scanIdx = RELEASE.indexOf("gstack-redact --from-file /tmp/gstack-pr-body");
    const editIdx = RELEASE.indexOf("gh pr edit --body-file /tmp/gstack-pr-body");
    expect(scanIdx).toBeGreaterThan(-1);
    expect(editIdx).toBeGreaterThan(scanIdx);
  });
  test("HIGH blocks the edit", () => {
    expect(RELEASE).toMatch(/exit 3 \(HIGH\).*do NOT edit/i);
  });
});

describe("/document-generate redaction", () => {
  test("scans staged doc diff before commit", () => {
    const scanIdx = GENERATE.indexOf("gstack-redact --repo-visibility");
    const commitIdx = GENERATE.indexOf("git commit -m");
    expect(scanIdx).toBeGreaterThan(-1);
    expect(commitIdx).toBeGreaterThan(scanIdx);
  });
  test("scans added lines of the staged diff", () => {
    expect(GENERATE).toMatch(/git diff --cached[\s\S]{0,80}gstack-redact/);
  });
  test("HIGH blocks the commit", () => {
    expect(GENERATE).toMatch(/Do NOT commit/i);
  });
});
