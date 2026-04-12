import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
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

  const resolved = resolveProjectWorkspace({
    projectId: "mypetroutine",
    memoryStore,
    pathExists: (path) => path === "/tmp/override-root",
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
