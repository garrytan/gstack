/**
 * Integration test: dry-run a synthetic 2-phase TDD plan through the CLI.
 */
import { test, expect, beforeAll, afterAll } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

const TDD_PLAN = `# Test Integration Plan

## Phases

### Phase 1: Foundation
- [ ] **Test Specification (Gemini Sub-agent)**: Write failing tests for foundation.
- [ ] **Implementation (Gemini Sub-agent)**: Implement foundation.
- [ ] **Review & QA (Codex Sub-agent)**: Review foundation.

### Phase 2: Integration
- [ ] **Test Specification (Gemini Sub-agent)**: Write failing tests for integration.
- [ ] **Implementation (Gemini Sub-agent)**: Implement integration.
- [ ] **Review & QA (Codex Sub-agent)**: Review integration.
`;

let tmpDir: string;
let planFile: string;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gstack-integration-"));
  planFile = path.join(tmpDir, "test-plan.md");
  fs.writeFileSync(planFile, TDD_PLAN);
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("dry-run TDD plan announces Test Specification and Verify Red for each phase", () => {
  const cliPath = path.resolve(import.meta.dir, "../cli.ts");
  const result = spawnSync(
    "bun",
    ["run", cliPath, planFile, "--dry-run", "--test-cmd", "bun test", "--no-gbrain"],
    {
      env: {
        ...process.env,
        HOME: tmpDir,
        GSTACK_HOME: path.join(tmpDir, ".gstack"),
      },
      encoding: "utf8",
      timeout: 30_000,
    }
  );

  const out = result.stdout + result.stderr;

  // Phase 5 impl must update the log from "writing test spec" -> "Test Specification"
  expect(out).toContain("Test Specification");
  // Verify Red step must be announced
  expect(out).toContain("Verify Red");
  // Both phases must appear in output
  expect((out.match(/Phase 1/g) ?? []).length).toBeGreaterThan(0);
  expect((out.match(/Phase 2/g) ?? []).length).toBeGreaterThan(0);
  // Dry-run must complete successfully
  expect(result.status).toBe(0);
});

test("dry-run with --dual-impl announces Dual Impl, Judge, and Apply Winner", () => {
  const cliPath = path.resolve(import.meta.dir, "../cli.ts");
  const result = spawnSync(
    "bun",
    [
      "run",
      cliPath,
      planFile,
      "--dry-run",
      "--dual-impl",
      "--test-cmd",
      "bun test",
      "--no-gbrain",
      "--no-resume", // ensure fresh state for this run
    ],
    {
      env: {
        ...process.env,
        HOME: tmpDir,
        GSTACK_HOME: path.join(tmpDir, ".gstack-dual"),
      },
      encoding: "utf8",
      timeout: 30_000,
    }
  );

  const out = result.stdout + result.stderr;

  expect(out).toContain("Dual Impl");
  expect(out).toContain("Dual Tests");
  expect(out).toContain("Judge");
  expect(out).toContain("Apply Winner");
  // TDD steps still run after dual-impl hands off to impl_done.
  expect(out).toContain("Test Specification");
  expect(out).toContain("Verify Red");
  // Dry-run must complete successfully.
  expect(result.status).toBe(0);
});

test("resume stops on a paused feature instead of marking it running", () => {
  const pausedDir = fs.mkdtempSync(path.join(os.tmpdir(), "gstack-paused-feature-"));
  try {
    const pausedPlanFile = path.join(pausedDir, "paused-plan.md");
    fs.writeFileSync(
      pausedPlanFile,
      `# Paused Plan

## Feature 1: Paused

### Phase 1.1: Done
- [x] **Test Specification (Gemini Sub-agent)**: Existing tests.
- [x] **Implementation (Gemini Sub-agent)**: Existing implementation.
- [x] **Review & QA (Codex Sub-agent)**: Existing review.
`
    );

    const stateDir = path.join(pausedDir, ".gstack", "build-state");
    fs.mkdirSync(stateDir, { recursive: true });
    const stateFile = path.join(stateDir, "build-paused-plan.json");
    const now = "2026-04-30T00:00:00.000Z";
    fs.writeFileSync(
      stateFile,
      JSON.stringify(
        {
          planFile: pausedPlanFile,
          planBasename: "paused-plan",
          slug: "build-paused-plan",
          branch: "feat/paused-plan-1-paused",
          startedAt: now,
          lastUpdatedAt: now,
          currentPhaseIndex: 0,
          currentFeatureIndex: 0,
          features: [
            {
              index: 0,
              number: "1",
              name: "Paused",
              phaseIndexes: [0],
              status: "paused",
              error: "needs user judgment",
            },
          ],
          phases: [
            {
              index: 0,
              number: "1.1",
              name: "Done",
              status: "committed",
            },
          ],
          completed: false,
          geminiModel: "gemini",
          codexModel: "codex",
          codexReviewModel: "codex-review",
        },
        null,
        2
      )
    );

    const cliPath = path.resolve(import.meta.dir, "../cli.ts");
    const result = spawnSync(
      "bun",
      ["run", cliPath, pausedPlanFile, "--dry-run", "--test-cmd", "bun test", "--no-gbrain"],
      {
        env: {
          ...process.env,
          HOME: pausedDir,
          GSTACK_HOME: path.join(pausedDir, ".gstack"),
        },
        encoding: "utf8",
        timeout: 30_000,
      }
    );

    const out = result.stdout + result.stderr;
    const saved = JSON.parse(fs.readFileSync(stateFile, "utf8"));

    expect(result.status).toBe(1);
    expect(out).toContain("Feature 1 is paused: needs user judgment");
    expect(out).not.toContain("all features done");
    expect(saved.features[0].status).toBe("paused");
    expect(saved.features[0].error).toBe("needs user judgment");
  } finally {
    fs.rmSync(pausedDir, { recursive: true, force: true });
  }
});

test("resume continues landed features at origin verification without checking out feature branch", () => {
  const landedDir = fs.mkdtempSync(path.join(os.tmpdir(), "gstack-landed-feature-"));
  try {
    const repo = path.join(landedDir, "repo");
    fs.mkdirSync(repo);
    expect(spawnSync("git", ["init", "-b", "main"], { cwd: repo }).status).toBe(0);
    expect(spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: repo }).status).toBe(0);
    expect(spawnSync("git", ["config", "user.name", "Test User"], { cwd: repo }).status).toBe(0);
    fs.writeFileSync(path.join(repo, "README.md"), "# test\n");
    expect(spawnSync("git", ["add", "README.md"], { cwd: repo }).status).toBe(0);
    expect(spawnSync("git", ["commit", "-m", "init"], { cwd: repo }).status).toBe(0);

    const landedPlanFile = path.join(landedDir, "landed-plan.md");
    fs.writeFileSync(
      landedPlanFile,
      `# Landed Plan

## Feature 1: Landed

### Phase 1.1: Done
- [x] **Test Specification (Gemini Sub-agent)**: Existing tests.
- [x] **Implementation (Gemini Sub-agent)**: Existing implementation.
- [x] **Review & QA (Codex Sub-agent)**: Existing review.
`
    );

    const stateDir = path.join(landedDir, ".gstack", "build-state");
    fs.mkdirSync(stateDir, { recursive: true });
    const stateFile = path.join(stateDir, "build-landed-plan.json");
    const now = "2026-04-30T00:00:00.000Z";
    fs.writeFileSync(
      stateFile,
      JSON.stringify(
        {
          planFile: landedPlanFile,
          planBasename: "landed-plan",
          slug: "build-landed-plan",
          branch: "feat/already-landed-and-deleted",
          startedAt: now,
          lastUpdatedAt: now,
          currentPhaseIndex: 0,
          currentFeatureIndex: 0,
          features: [
            {
              index: 0,
              number: "1",
              name: "Landed",
              phaseIndexes: [0],
              status: "landed",
              branch: "feat/already-landed-and-deleted",
              landedAt: now,
            },
          ],
          phases: [
            {
              index: 0,
              number: "1.1",
              name: "Done",
              status: "committed",
            },
          ],
          completed: false,
          geminiModel: "gemini",
          codexModel: "codex",
          codexReviewModel: "codex-review",
        },
        null,
        2
      )
    );

    const cliPath = path.resolve(import.meta.dir, "../cli.ts");
    const result = spawnSync(
      "bun",
      [
        "run",
        cliPath,
        landedPlanFile,
        "--project-root",
        repo,
        "--skip-ship",
        "--test-cmd",
        "bun test",
        "--no-gbrain",
      ],
      {
        env: {
          ...process.env,
          HOME: landedDir,
          GSTACK_HOME: path.join(landedDir, ".gstack"),
        },
        encoding: "utf8",
        timeout: 30_000,
      }
    );

    const out = result.stdout + result.stderr;
    const saved = JSON.parse(fs.readFileSync(stateFile, "utf8"));

    expect(result.status).toBe(0);
    expect(out).toContain("origin-plan-verification");
    expect(out).not.toContain("checking out feat/already-landed-and-deleted");
    expect(saved.features[0].status).toBe("origin_verified");
  } finally {
    fs.rmSync(landedDir, { recursive: true, force: true });
  }
});

test("--skip-ship leaves completed features ready to ship on a later resume", () => {
  const skipDir = fs.mkdtempSync(path.join(os.tmpdir(), "gstack-skip-ship-feature-"));
  try {
    const repo = path.join(skipDir, "repo");
    const bare = path.join(skipDir, "origin.git");
    fs.mkdirSync(repo);
    expect(spawnSync("git", ["init", "-b", "main"], { cwd: repo }).status).toBe(0);
    expect(spawnSync("git", ["init", "--bare", "-b", "main", bare]).status).toBe(0);
    expect(spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: repo }).status).toBe(0);
    expect(spawnSync("git", ["config", "user.name", "Test User"], { cwd: repo }).status).toBe(0);
    fs.writeFileSync(path.join(repo, "README.md"), "# test\n");
    expect(spawnSync("git", ["add", "README.md"], { cwd: repo }).status).toBe(0);
    expect(spawnSync("git", ["commit", "-m", "init"], { cwd: repo }).status).toBe(0);
    expect(spawnSync("git", ["remote", "add", "origin", bare], { cwd: repo }).status).toBe(0);
    expect(spawnSync("git", ["push", "-u", "origin", "main"], { cwd: repo }).status).toBe(0);

    const skipPlanFile = path.join(skipDir, "skip-plan.md");
    fs.writeFileSync(
      skipPlanFile,
      `# Skip Ship Plan

## Feature 1: Ready

### Phase 1.1: Done
- [x] **Test Specification (Gemini Sub-agent)**: Existing tests.
- [x] **Implementation (Gemini Sub-agent)**: Existing implementation.
- [x] **Review & QA (Codex Sub-agent)**: Existing review.

## Feature 2: Also Ready

### Phase 2.1: Done
- [x] **Test Specification (Gemini Sub-agent)**: Existing tests.
- [x] **Implementation (Gemini Sub-agent)**: Existing implementation.
- [x] **Review & QA (Codex Sub-agent)**: Existing review.
`
    );

    const cliPath = path.resolve(import.meta.dir, "../cli.ts");
    const result = spawnSync(
      "bun",
      [
        "run",
        cliPath,
        skipPlanFile,
        "--project-root",
        repo,
        "--skip-ship",
        "--test-cmd",
        "bun test",
        "--no-gbrain",
      ],
      {
        env: {
          ...process.env,
          HOME: skipDir,
          GSTACK_HOME: path.join(skipDir, ".gstack"),
        },
        encoding: "utf8",
        timeout: 30_000,
      }
    );

    const stateFile = path.join(skipDir, ".gstack", "build-state", "build-skip-plan.json");
    const saved = JSON.parse(fs.readFileSync(stateFile, "utf8"));

    expect(result.status).toBe(0);
    expect(saved.features[0].status).toBe("origin_verified");
    expect(saved.features[1].status).toBe("origin_verified");
    expect(saved.features[0].branch).not.toBe(saved.features[1].branch);
    expect(saved.features[0].branch).toContain("ready");
    expect(saved.features[1].branch).toContain("also-ready");
    expect(saved.features[0].completedAt).toBeUndefined();
    expect(saved.features[1].completedAt).toBeUndefined();
    expect(saved.completed).toBe(false);
  } finally {
    fs.rmSync(skipDir, { recursive: true, force: true });
  }
});
