import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import {
  loadOpenClawContextArtifacts,
  resolveOpenClawWorkspaceRoot,
} from "../src/memory/openclaw-context";

test("resolveOpenClawWorkspaceRoot prefers configured OpenClaw workspace", () => {
  expect(resolveOpenClawWorkspaceRoot({
    env: {},
    home: "/home/tony",
    openclawConfig: {
      agents: {
        defaults: {
          workspace: "/home/tony/.openclaw/workspace",
        },
      },
    },
  })).toBe("/home/tony/.openclaw/workspace");
});

test("loadOpenClawContextArtifacts pulls SOUL/AGENTS/USER and repo AGENTS context", () => {
  const root = mkdtempSync(join(tmpdir(), "rico-openclaw-"));
  const workspace = join(root, "workspace");
  const repo = join(root, "repo");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(repo, { recursive: true });

  writeFileSync(join(workspace, "SOUL.md"), "# soul\nbe useful");
  writeFileSync(join(workspace, "AGENTS.md"), "# agents\nread memory first");
  writeFileSync(join(workspace, "USER.md"), "# user\nTony prefers Korean");
  writeFileSync(join(repo, "AGENTS.md"), "# repo agents\nfollow repo rules");

  const artifacts = loadOpenClawContextArtifacts({
    workspacePath: workspace,
    repoPath: repo,
    maxCharsPerFile: 200,
  });

  expect(artifacts.map((artifact) => artifact.title)).toEqual([
    "openclaw-soul.md",
    "openclaw-agents.md",
    "openclaw-user.md",
    "repo-agents.md",
  ]);
  expect(artifacts[0]?.body).toContain("be useful");
  expect(artifacts[3]?.body).toContain("follow repo rules");

  rmSync(root, { recursive: true, force: true });
});
