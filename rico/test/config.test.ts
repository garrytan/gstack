import { test, expect } from "bun:test";
import { resolveConfig } from "../src/config";

test("resolveConfig defaults state paths under .gstack/rico", () => {
  const cfg = resolveConfig({ cwd: "/tmp/demo-repo", env: {} });
  expect(cfg.stateDir).toBe("/tmp/demo-repo/.gstack/rico");
  expect(cfg.dbPath).toBe("/tmp/demo-repo/.gstack/rico/rico.sqlite");
  expect(cfg.artifactDir).toBe("/tmp/demo-repo/.gstack/rico/artifacts");
  expect(cfg.maxActiveProjects).toBe(2);
});
