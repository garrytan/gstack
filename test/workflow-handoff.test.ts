import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { spawnSync } from "child_process";

const ROOT = join(import.meta.dir, "..");
const reviewLogBin = join(ROOT, "bin", "gstack-review-log");
const reviewReadBin = join(ROOT, "bin", "gstack-review-read");
const findArtifactBin = join(ROOT, "bin", "gstack-find-artifact");

function run(cmd: string, args: string[], cwd: string, env: Record<string, string>) {
  const result = spawnSync(cmd, args, {
    cwd,
    env: { ...process.env, ...env },
    encoding: "utf-8",
    timeout: 10000,
  });
  return result;
}

function initRepo(): { repoDir: string; stateDir: string; projectDir: string } {
  const repoDir = mkdtempSync(join(tmpdir(), "gstack-workflow-"));
  const stateDir = mkdtempSync(join(tmpdir(), "gstack-state-"));

  run("git", ["init", "-b", "main"], repoDir, {});
  run("git", ["config", "user.name", "Test User"], repoDir, {});
  run("git", ["config", "user.email", "test@example.com"], repoDir, {});
  run("git", ["remote", "add", "origin", "https://github.com/example-org/example-repo.git"], repoDir, {});
  writeFileSync(join(repoDir, "README.md"), "test\n");
  run("git", ["add", "README.md"], repoDir, {});
  run("git", ["commit", "-m", "initial"], repoDir, {});

  const projectDir = join(stateDir, "projects", "example-org-example-repo");
  mkdirSync(projectDir, { recursive: true });

  return { repoDir, stateDir, projectDir };
}

describe("workflow handoff helpers", () => {
  let repoDir: string;
  let stateDir: string;
  let projectDir: string;

  beforeEach(() => {
    ({ repoDir, stateDir, projectDir } = initRepo());
  });

  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  });

  test("gstack-review-read sees reviews logged on a different branch via project-scoped JSONL", () => {
    let result = run("git", ["checkout", "-b", "feature/one"], repoDir, {});
    expect(result.status).toBe(0);

    result = run("bash", [reviewLogBin, '{"skill":"review","timestamp":"2026-03-23T10:00:00Z","status":"clean"}'], repoDir, {
      GSTACK_HOME: stateDir,
    });
    expect(result.status).toBe(0);

    result = run("git", ["checkout", "main"], repoDir, {});
    expect(result.status).toBe(0);
    result = run("git", ["checkout", "-b", "feature/two"], repoDir, {});
    expect(result.status).toBe(0);

    result = run("bash", [reviewReadBin], repoDir, { GSTACK_HOME: stateDir });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('"skill":"review"');
    expect(result.stdout).toContain('2026-03-23T10:00:00Z');
  });

  test("gstack-review-read falls back to legacy per-branch logs when project log does not exist", () => {
    writeFileSync(
      join(projectDir, "feature-one-reviews.jsonl"),
      '{"skill":"plan-ceo-review","timestamp":"2026-03-23T09:00:00Z","status":"clean"}\n'
    );
    writeFileSync(
      join(projectDir, "feature-two-reviews.jsonl"),
      '{"skill":"review","timestamp":"2026-03-23T11:00:00Z","status":"clean"}\n'
    );

    const result = run("bash", [reviewReadBin], repoDir, { GSTACK_HOME: stateDir });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('"skill":"plan-ceo-review"');
    expect(result.stdout).toContain('"skill":"review"');
  });

  test("gstack-find-artifact prefers the current branch design doc", () => {
    run("git", ["checkout", "-b", "feature/two"], repoDir, {});
    writeFileSync(
      join(projectDir, "alice-feature-one-design-20260323-090000.md"),
      "Branch: feature-one\nStatus: DRAFT\n"
    );
    writeFileSync(
      join(projectDir, "alice-feature-two-design-20260323-100000.md"),
      "Branch: feature-two\nStatus: DRAFT\n"
    );

    const result = run("bash", [findArtifactBin, "design-doc"], repoDir, { GSTACK_HOME: stateDir });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toContain("feature-two-design");
  });

  test("gstack-find-artifact finds the active CEO plan for the current branch", () => {
    run("git", ["checkout", "-b", "feature/two"], repoDir, {});
    mkdirSync(join(projectDir, "ceo-plans"), { recursive: true });
    writeFileSync(
      join(projectDir, "ceo-plans", "2026-03-20-other-plan.md"),
      "---\nstatus: ACTIVE\n---\nBranch: feature-one\n"
    );
    writeFileSync(
      join(projectDir, "ceo-plans", "2026-03-21-current-plan.md"),
      "---\nstatus: ACTIVE\n---\nBranch: feature-two\n"
    );

    const result = run("bash", [findArtifactBin, "ceo-plan"], repoDir, { GSTACK_HOME: stateDir });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toContain("current-plan");
  });
});
