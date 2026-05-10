import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..");

function readSkill(relativePath: string): string {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf-8");
}

describe("gstack-upgrade skill", () => {
  test("git upgrades merge upstream into the local customized version", () => {
    const tmpl = readSkill("gstack-upgrade/SKILL.md.tmpl");

    expect(tmpl).toContain("preserve the user");
    expect(tmpl).toContain("git fetch origin main");
    expect(tmpl).toContain("git merge --no-edit origin/main");
    expect(tmpl).toContain(
      'git switch "$CURRENT_BRANCH" 2>/dev/null || git switch -c "$CURRENT_BRANCH"',
    );
    expect(tmpl).not.toContain("git reset --hard origin/main");
  });

  test("upgrade flow audits generated skills and custom preamble users", () => {
    const tmpl = readSkill("gstack-upgrade/SKILL.md.tmpl");

    expect(tmpl).toContain("Regenerate and audit skill consistency");
    expect(tmpl).toContain("bun run gen:skill-docs --host all");
    expect(tmpl).toContain("bun run skill:check");
    expect(tmpl).toContain("build/SKILL.md.tmpl");
    expect(tmpl).toContain("PREAMBLE placeholder");
  });

  test("Step 4.8 fork overlay reads fork_repo_path, scopes to SKILL.md.tmpl, and guards against traversal", () => {
    const tmpl = readSkill("gstack-upgrade/SKILL.md.tmpl");

    // reads fork_repo_path via $INSTALL_DIR-relative config (not hardcoded host path)
    expect(tmpl).toContain(
      '"$INSTALL_DIR/bin/gstack-config" get fork_repo_path',
    );
    expect(tmpl).not.toContain(
      "~/.claude/skills/gstack/bin/gstack-config get fork_repo_path",
    );

    // uses git diff to detect fork-specific changes
    expect(tmpl).toContain('git diff "$_BASE_REF"...HEAD --name-only');

    // scoped to SKILL.md.tmpl only — not all .tmpl files
    expect(tmpl).toContain("grep '/SKILL\\.md\\.tmpl$'");
    expect(tmpl).not.toMatch(/grep '\\\.tmpl\$'/);

    // traversal guard present in copy loop
    expect(tmpl).toContain("*..*)");
    expect(tmpl).toContain("SKIP: suspicious path (traversal)");

    // fetch failure is warned, not silently swallowed
    expect(tmpl).toContain("git fetch upstream failed");
  });

  test("Step 4.9 syncs SKILL.md files to gemini and kimi host directories", () => {
    const tmpl = readSkill("gstack-upgrade/SKILL.md.tmpl");

    expect(tmpl).toContain(".gemini/skills/gstack");
    expect(tmpl).toContain(".kimi/skills/gstack");
    // step is documented as distinct from 4.8
    expect(tmpl).toContain("Step 4.9");
  });
});
