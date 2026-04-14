import { expect, test } from "bun:test";
import { MemoryStore } from "../src/memory/store";
import {
  applyProjectWorkspaceCommand,
  parseProjectWorkspaceCommand,
} from "../src/slack/project-workspace-commands";
import { openStore } from "../src/state/store";

test("parseProjectWorkspaceCommand recognizes git remote URLs", () => {
  expect(parseProjectWorkspaceCommand("저장소: git@github.com:xogjs/Crypto.git")).toEqual({
    type: "set-repo-url",
    repoUrl: "git@github.com:xogjs/Crypto.git",
  });
});

test("parseProjectWorkspaceCommand recognizes natural-language local repo discovery asks", () => {
  expect(parseProjectWorkspaceCommand("로컬 경로 탐색을 해서 찾아봐")).toEqual({
    type: "auto",
  });
  expect(parseProjectWorkspaceCommand("저장소 탐색해서 찾아봐")).toEqual({
    type: "auto",
  });
});

test("applyProjectWorkspaceCommand stores repo URL separately from repo root", () => {
  const store = openStore(":memory:");
  const memoryStore = new MemoryStore(store.db);

  const text = applyProjectWorkspaceCommand({
    memoryStore,
    projectId: "crypto",
    command: {
      type: "set-repo-url",
      repoUrl: "git@github.com:xogjs/Crypto.git",
    },
  });

  expect(text).toContain("git@github.com:xogjs/Crypto.git");
  expect(memoryStore.getProjectMemory("crypto")).toMatchObject({
    "project.repo_url": "git@github.com:xogjs/Crypto.git",
    "project.repo_url_source": "manual",
  });
  expect(
    memoryStore.getProjectMemory("crypto")["project.repo_root"] == null
    || memoryStore.getProjectMemory("crypto")["project.repo_root_source"] === "auto-url-match",
  ).toBe(true);

  store.db.close();
});
