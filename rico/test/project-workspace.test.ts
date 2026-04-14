import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { MemoryStore } from "../src/memory/store";
import { resolveProjectWorkspace } from "../src/orchestrator/project-workspace";
import { openStore } from "../src/state/store";

test("resolveProjectWorkspace uses stored override before scanning", () => {
  const db = openStore(":memory:");
  const memoryStore = new MemoryStore(db.db);
  memoryStore.putProjectFact("mypetroutine", "project.repo_root", "/tmp/override-root");
  memoryStore.putProjectFact("mypetroutine", "project.repo_root_source", "manual");

  const resolved = resolveProjectWorkspace({
    projectId: "mypetroutine",
    memoryStore,
    pathExists: (path) => path.startsWith("/tmp/override-root"),
    listDirectories: () => [],
  });

  expect(resolved).toBe("/tmp/override-root");
  db.db.close();
});

test("resolveProjectWorkspace finds fuzzy project matches and persists them", () => {
  const root = mkdtempSync(join(tmpdir(), "rico-workspaces-"));
  const memorial = join(root, "pet_memorial_moltdog");
  mkdirSync(memorial);

  const db = openStore(":memory:");
  const memoryStore = new MemoryStore(db.db);

  const resolved = resolveProjectWorkspace({
    projectId: "pet-memorial",
    memoryStore,
    candidateRoots: [root],
  });

  expect(resolved).toBe(memorial);
  expect(memoryStore.getProjectMemory("pet-memorial")["project.repo_root"]).toBe(memorial);

  rmSync(root, { recursive: true, force: true });
  db.db.close();
});

test("resolveProjectWorkspace prefers repo-shaped candidates over empty name matches", () => {
  const root = mkdtempSync(join(tmpdir(), "rico-workspaces-priority-"));
  const emptyMatch = join(root, "mypetroutine");
  const richMatch = join(root, "mypetroutine-workspace");
  mkdirSync(emptyMatch);
  mkdirSync(richMatch);
  mkdirSync(join(richMatch, "src"));
  mkdirSync(join(richMatch, ".git"));
  writeFileSync(join(richMatch, "package.json"), "{}");

  const resolved = resolveProjectWorkspace({
    projectId: "mypetroutine",
    candidateRoots: [root],
  });

  expect(resolved).toBe(richMatch);

  rmSync(root, { recursive: true, force: true });
});

test("resolveProjectWorkspace replaces a stale override when a richer candidate exists", () => {
  const root = mkdtempSync(join(tmpdir(), "rico-workspaces-stale-"));
  const richMatch = join(root, "mypetroutine-workspace");
  mkdirSync(richMatch);
  mkdirSync(join(richMatch, "src"));
  mkdirSync(join(richMatch, ".git"));
  writeFileSync(join(richMatch, "package.json"), "{}");

  const db = openStore(":memory:");
  const memoryStore = new MemoryStore(db.db);
  memoryStore.putProjectFact("mypetroutine", "project.repo_root", "/tmp/stale-worktree");

  const resolved = resolveProjectWorkspace({
    projectId: "mypetroutine",
    memoryStore,
    candidateRoots: [root],
    pathExists: (path) =>
      path === "/tmp/stale-worktree" || path === root || path.startsWith(richMatch),
  });

  expect(resolved).toBe(richMatch);
  expect(memoryStore.getProjectMemory("mypetroutine")["project.repo_root"]).toBe(richMatch);

  rmSync(root, { recursive: true, force: true });
  db.db.close();
});

test("resolveProjectWorkspace does not pick an unrelated repo-shaped candidate", () => {
  const root = mkdtempSync(join(tmpdir(), "rico-workspaces-unrelated-"));
  const unrelated = join(root, "mypetroutine-workspace");
  mkdirSync(unrelated);
  mkdirSync(join(unrelated, "src"));
  mkdirSync(join(unrelated, ".git"));
  writeFileSync(join(unrelated, "package.json"), "{}");

  const resolved = resolveProjectWorkspace({
    projectId: "crypto",
    candidateRoots: [root],
  });

  expect(resolved).toBeNull();

  rmSync(root, { recursive: true, force: true });
});

test("resolveProjectWorkspace can match a stored repo URL to a local repo root", () => {
  const root = mkdtempSync(join(tmpdir(), "rico-workspaces-remote-"));
  const candidate = join(root, "workspace-123");
  mkdirSync(candidate);
  mkdirSync(join(candidate, ".git"));
  mkdirSync(join(candidate, "src"));
  writeFileSync(
    join(candidate, ".git", "config"),
    [
      '[remote "origin"]',
      "  url = https://github.com/xogjs/Crypto.git",
    ].join("\n"),
  );
  writeFileSync(join(candidate, "package.json"), "{}");

  const db = openStore(":memory:");
  const memoryStore = new MemoryStore(db.db);
  memoryStore.putProjectFact("crypto", "project.repo_url", "git@github.com:xogjs/Crypto.git");
  memoryStore.putProjectFact("crypto", "project.repo_url_source", "manual");

  const resolved = resolveProjectWorkspace({
    projectId: "crypto",
    memoryStore,
    candidateRoots: [root],
  });

  expect(resolved).toBe(candidate);
  expect(memoryStore.getProjectMemory("crypto")["project.repo_root"]).toBe(candidate);
  expect(memoryStore.getProjectMemory("crypto")["project.repo_root_source"]).toBe("auto-url-match");

  rmSync(root, { recursive: true, force: true });
  db.db.close();
});
