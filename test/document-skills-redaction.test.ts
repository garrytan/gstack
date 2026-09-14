/**
 * /document-release + /document-generate redaction wiring (T6/T7).
 */
import { describe, test, expect } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import { spawnSync } from "child_process";

const ROOT = path.resolve(import.meta.dir, "..");
// document-release is carved (skeleton + sections/release-body.md). Step 9
// (commit + PR-body redaction scan) moved into the section template; check the
// union of SKILL.md.tmpl + sections/*.md.tmpl so the scan-before-edit ordering
// still verifies. document-generate is NOT carved (plain .md.tmpl).
function unionTmpl(skill: string): string {
  let t = fs.readFileSync(path.join(ROOT, skill, "SKILL.md.tmpl"), "utf-8");
  const dir = path.join(ROOT, skill, "sections");
  if (fs.existsSync(dir)) {
    for (const f of fs.readdirSync(dir).sort()) {
      if (f.endsWith(".md.tmpl")) t += "\n" + fs.readFileSync(path.join(dir, f), "utf-8");
    }
  }
  return t;
}
const RELEASE = unionTmpl("document-release");
const GENERATE = fs.readFileSync(path.join(ROOT, "document-generate", "SKILL.md.tmpl"), "utf-8");

describe("/document-release redaction", () => {
  test("scans the PR-body temp file before gh pr edit", () => {
    const scanIdx = RELEASE.indexOf('gstack-redact --from-file "<run-dir>/body.md"');
    const editIdx = RELEASE.indexOf('gh pr edit --body-file "<run-dir>/body.md"');
    expect(scanIdx).toBeGreaterThan(-1);
    expect(editIdx).toBeGreaterThan(scanIdx);
  });
  test("HIGH blocks the edit", () => {
    expect(RELEASE).toMatch(/exit 3 \(HIGH\).*do NOT edit/i);
  });
  test("separate shell calls share an explicit run directory and never re-read raw tracker text", () => {
    expect(RELEASE).toContain('mktemp -d /tmp/gstack-doc-release-XXXXXXXX');
    expect(RELEASE).not.toContain('/tmp/gstack-pr-body-$$');
    expect(RELEASE).not.toContain('<paste the file contents here>');
    expect(RELEASE).toContain('pathlib.Path(sys.argv[1]).read_text()');
  });
  test("title synchronization keeps every variable in one valid shell block", () => {
    const section = RELEASE.slice(RELEASE.indexOf('**PR/MR title sync'));
    const script = section.match(/```bash\n([\s\S]*?)\n```/)![1];
    for (const command of ['V=$(cat VERSION', 'CURRENT_TITLE=$(gh pr view', 'NEW_TITLE=$(', 'gh pr edit --title "$NEW_TITLE"', 'glab mr update -t "$NEW_TITLE"']) {
      expect(script).toContain(command);
    }
    const result = spawnSync('bash', ['-n'], { input: script, encoding: 'utf8', timeout: 5000 });
    expect(result.status, result.stderr).toBe(0);
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
