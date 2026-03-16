import { describe, test, expect } from "bun:test";
import * as fs from "fs";
import * as path from "path";

const ROOT = path.resolve(import.meta.dir, "..");
const CODEX_SKILLS = [
  "gstack-browse",
  "gstack-qa",
  "gstack-review",
  "gstack-plan-ceo-review",
  "gstack-plan-eng-review",
  "gstack-browser-cookies",
  "gstack-ship",
  "gstack-retro",
] as const;

describe("Codex skill packaging", () => {
  test("all Codex skills exist and stay free of Claude-only references", () => {
    for (const skill of CODEX_SKILLS) {
      const skillPath = path.join(ROOT, ".codex", "skills", skill, "SKILL.md");
      expect(fs.existsSync(skillPath)).toBe(true);

      const content = fs.readFileSync(skillPath, "utf-8");
      expect(content.startsWith("---\n")).toBe(true);
      expect(content).toContain("references/workflows/");
      expect(content).not.toContain(".claude/skills");
      expect(content).not.toContain("AskUserQuestion");
      expect(content).not.toContain("mcp__claude-in-chrome");
    }
  });

  test("AGENTS.md documents the slash-to-skill compatibility contract", () => {
    const content = fs.readFileSync(path.join(ROOT, "AGENTS.md"), "utf-8");
    expect(content).toContain("/browse");
    expect(content).toContain("gstack-browse");
    expect(content).toContain("/qa");
    expect(content).toContain("gstack-qa");
  });
});

describe("Codex alias wrappers", () => {
  test("gstack-browse wrapper emits the Codex skill name and slash alias", () => {
    const result = Bun.spawnSync(
      ["bash", path.join(ROOT, "bin", "gstack-browse"), "https://example.com"],
      {
        stdout: "pipe",
        stderr: "pipe",
      },
    );

    expect(result.exitCode).toBe(0);
    const stdout = result.stdout.toString();
    expect(stdout).toContain("Codex skill: gstack-browse");
    expect(stdout).toContain("Compatibility alias: /browse");
    expect(stdout).toContain("https://example.com");
  });

  test("gstack-qa wrapper emits the Codex skill name and workflow doc", () => {
    const result = Bun.spawnSync(["bash", path.join(ROOT, "bin", "gstack-qa")], {
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).toBe(0);
    const stdout = result.stdout.toString();
    expect(stdout).toContain("Codex skill: gstack-qa");
    expect(stdout).toContain("references/workflows/qa.md");
  });
});
