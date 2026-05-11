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
    [
      "run",
      cliPath,
      planFile,
      "--dry-run",
      "--test-cmd",
      "bun test",
      "--no-gbrain",
    ],
    {
      env: {
        ...process.env,
        HOME: tmpDir,
        GSTACK_HOME: path.join(tmpDir, ".gstack"),
      },
      encoding: "utf8",
      timeout: 30_000,
    },
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

test("dry-run legacy two-checkbox plan skips TDD red/green steps but completes", () => {
  const legacyPlanFile = path.join(tmpDir, "legacy-plan.md");
  fs.writeFileSync(
    legacyPlanFile,
    `# Legacy Integration Plan

## Feature 1: Legacy

### Phase 1: Legacy parser
- [ ] **Implementation (Gemini Sub-agent)**: Implement parser behavior.
- [ ] **Review & QA (Codex Sub-agent)**: Review parser behavior.
`,
  );
  const cliPath = path.resolve(import.meta.dir, "../cli.ts");
  const result = spawnSync(
    "bun",
    [
      "run",
      cliPath,
      legacyPlanFile,
      "--dry-run",
      "--test-cmd",
      "bun test",
      "--no-gbrain",
      "--no-resume",
    ],
    {
      env: {
        ...process.env,
        HOME: tmpDir,
        GSTACK_HOME: path.join(tmpDir, ".gstack-legacy"),
      },
      encoding: "utf8",
      timeout: 30_000,
    },
  );

  const out = result.stdout + result.stderr;

  expect(result.status).toBe(0);
  expect(out).toContain("Phase 1");
  expect(out).toContain("RUN_GEMINI");
  expect(out).toContain("RUN_CODEX_REVIEW");
  expect(out).not.toContain("Verify Red");
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
      "--primary-impl-provider",
      "gemini",
      "--judge-provider",
      "claude",
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
    },
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

test("dry-run with --parallel-phases prints conservative dependency batches", () => {
  const parallelPlanFile = path.join(tmpDir, "parallel-plan.md");
  fs.writeFileSync(
    parallelPlanFile,
    `# Parallel Plan

## Feature 1: Profile

### Phase 1.1: API schema
Touches: src/api/schema.ts
Depends on: none
- [ ] **Test Specification (Gemini Sub-agent)**: Write tests.
- [ ] **Implementation (Gemini Sub-agent)**: Implement.
- [ ] **Review & QA (Codex Sub-agent)**: Review.

### Phase 1.2: UI shell
Touches: src/ui/ProfileShell.tsx
Depends on: none
- [ ] **Test Specification (Gemini Sub-agent)**: Write tests.
- [ ] **Implementation (Gemini Sub-agent)**: Implement.
- [ ] **Review & QA (Codex Sub-agent)**: Review.

### Phase 1.3: Wire UI
Touches: src/ui/ProfilePage.tsx
Depends on: 1.1, 1.2
- [ ] **Test Specification (Gemini Sub-agent)**: Write tests.
- [ ] **Implementation (Gemini Sub-agent)**: Implement.
- [ ] **Review & QA (Codex Sub-agent)**: Review.
`,
  );
  const cliPath = path.resolve(import.meta.dir, "../cli.ts");
  const result = spawnSync(
    "bun",
    [
      "run",
      cliPath,
      parallelPlanFile,
      "--dry-run",
      "--parallel-phases",
      "2",
      "--test-cmd",
      "bun test",
      "--no-gbrain",
      "--no-resume",
    ],
    {
      env: {
        ...process.env,
        HOME: tmpDir,
        GSTACK_HOME: path.join(tmpDir, ".gstack-parallel"),
      },
      encoding: "utf8",
      timeout: 30_000,
    },
  );

  const out = result.stdout + result.stderr;

  expect(result.status).toBe(0);
  expect(out).toContain("Parallel phase planner");
  expect(out).toContain("Batch 1: Phase 1.1, Phase 1.2");
  expect(out).toContain("Batch 2: Phase 1.3");
});

test("dry-run with --parallel-phases fails closed on unknown dependencies", () => {
  const badPlanFile = path.join(tmpDir, "parallel-bad-plan.md");
  fs.writeFileSync(
    badPlanFile,
    `# Parallel Bad Plan

## Feature 1: Bad

### Phase 1.1: Consumer
Depends on: 9.9
Touches: src/consumer.ts
- [ ] **Implementation (Gemini Sub-agent)**: Implement.
- [ ] **Review & QA (Codex Sub-agent)**: Review.
`,
  );
  const cliPath = path.resolve(import.meta.dir, "../cli.ts");
  const result = spawnSync(
    "bun",
    [
      "run",
      cliPath,
      badPlanFile,
      "--dry-run",
      "--parallel-phases",
      "2",
      "--test-cmd",
      "bun test",
      "--no-gbrain",
      "--no-resume",
    ],
    {
      env: {
        ...process.env,
        HOME: tmpDir,
        GSTACK_HOME: path.join(tmpDir, ".gstack-parallel-bad"),
      },
      encoding: "utf8",
      timeout: 30_000,
    },
  );

  const out = result.stdout + result.stderr;

  expect(result.status).toBe(1);
  expect(out).toContain("Parallel phase planner failed closed");
  expect(out).toContain("unknown dependency 9.9");
});

test("non-dry-run with --parallel-phases fails closed until executor is implemented", () => {
  const parallelPlanFile = path.join(tmpDir, "parallel-non-dry-plan.md");
  fs.writeFileSync(
    parallelPlanFile,
    `# Parallel Non Dry Plan

## Feature 1: Profile

### Phase 1.1: API schema
Touches: src/api/schema.ts
- [ ] **Implementation (Gemini Sub-agent)**: Implement.
- [ ] **Review & QA (Codex Sub-agent)**: Review.

### Phase 1.2: UI shell
Touches: src/ui/ProfileShell.tsx
- [ ] **Implementation (Gemini Sub-agent)**: Implement.
- [ ] **Review & QA (Codex Sub-agent)**: Review.
`,
  );
  const cliPath = path.resolve(import.meta.dir, "../cli.ts");
  const result = spawnSync(
    "bun",
    [
      "run",
      cliPath,
      parallelPlanFile,
      "--parallel-phases",
      "2",
      "--skip-ship",
      "--test-cmd",
      "bun test",
      "--no-gbrain",
      "--no-resume",
    ],
    {
      env: {
        ...process.env,
        HOME: tmpDir,
        GSTACK_HOME: path.join(tmpDir, ".gstack-parallel-non-dry"),
      },
      encoding: "utf8",
      timeout: 30_000,
    },
  );

  const out = result.stdout + result.stderr;

  expect(result.status).toBe(2);
  expect(out).toContain(
    "--parallel-phases currently supports dependency planning only",
  );
  expect(out).toContain("rerun with --dry-run");
});

test("resume stops on a paused feature instead of marking it running", () => {
  const pausedDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "gstack-paused-feature-"),
  );
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
`,
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
        2,
      ),
    );

    const cliPath = path.resolve(import.meta.dir, "../cli.ts");
    const result = spawnSync(
      "bun",
      [
        "run",
        cliPath,
        pausedPlanFile,
        "--dry-run",
        "--test-cmd",
        "bun test",
        "--no-gbrain",
      ],
      {
        env: {
          ...process.env,
          HOME: pausedDir,
          GSTACK_HOME: path.join(pausedDir, ".gstack"),
        },
        encoding: "utf8",
        timeout: 30_000,
      },
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
  const landedDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "gstack-landed-feature-"),
  );
  try {
    const repo = path.join(landedDir, "repo");
    fs.mkdirSync(repo);
    expect(spawnSync("git", ["init", "-b", "main"], { cwd: repo }).status).toBe(
      0,
    );
    expect(
      spawnSync("git", ["config", "user.email", "test@example.com"], {
        cwd: repo,
      }).status,
    ).toBe(0);
    expect(
      spawnSync("git", ["config", "user.name", "Test User"], { cwd: repo })
        .status,
    ).toBe(0);
    fs.writeFileSync(path.join(repo, "README.md"), "# test\n");
    expect(spawnSync("git", ["add", "README.md"], { cwd: repo }).status).toBe(
      0,
    );
    expect(
      spawnSync("git", ["commit", "-m", "init"], { cwd: repo }).status,
    ).toBe(0);

    const landedPlanFile = path.join(landedDir, "landed-plan.md");
    fs.writeFileSync(
      landedPlanFile,
      `# Landed Plan

## Feature 1: Landed

### Phase 1.1: Done
- [x] **Test Specification (Gemini Sub-agent)**: Existing tests.
- [x] **Implementation (Gemini Sub-agent)**: Existing implementation.
- [x] **Review & QA (Codex Sub-agent)**: Existing review.
`,
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
        2,
      ),
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
        "--no-plan-review",
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
      },
    );

    const out = result.stdout + result.stderr;
    const saved = JSON.parse(fs.readFileSync(stateFile, "utf8"));

    expect(result.status).toBe(13); // FINALIZATION_REQUIRED: feature stuck at origin_verified
    expect(out).toContain("origin-plan-verification");
    expect(out).not.toContain("checking out feat/already-landed-and-deleted");
    expect(saved.features[0].status).toBe("origin_verified");
  } finally {
    fs.rmSync(landedDir, { recursive: true, force: true });
  }
});

test("--skip-ship leaves completed features ready to ship on a later resume", () => {
  const skipDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "gstack-skip-ship-feature-"),
  );
  try {
    const repo = path.join(skipDir, "repo");
    const bare = path.join(skipDir, "origin.git");
    fs.mkdirSync(repo);
    expect(spawnSync("git", ["init", "-b", "main"], { cwd: repo }).status).toBe(
      0,
    );
    expect(
      spawnSync("git", ["init", "--bare", "-b", "main", bare]).status,
    ).toBe(0);
    expect(
      spawnSync("git", ["config", "user.email", "test@example.com"], {
        cwd: repo,
      }).status,
    ).toBe(0);
    expect(
      spawnSync("git", ["config", "user.name", "Test User"], { cwd: repo })
        .status,
    ).toBe(0);
    fs.writeFileSync(path.join(repo, "README.md"), "# test\n");
    expect(spawnSync("git", ["add", "README.md"], { cwd: repo }).status).toBe(
      0,
    );
    expect(
      spawnSync("git", ["commit", "-m", "init"], { cwd: repo }).status,
    ).toBe(0);
    expect(
      spawnSync("git", ["remote", "add", "origin", bare], { cwd: repo }).status,
    ).toBe(0);
    expect(
      spawnSync("git", ["push", "-u", "origin", "main"], { cwd: repo }).status,
    ).toBe(0);

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
`,
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
        "--no-plan-review",
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
      },
    );

    const stateFile = path.join(
      skipDir,
      ".gstack",
      "build-state",
      "build-skip-plan.json",
    );
    const saved = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    const out = result.stdout + result.stderr;
    const analyticsFile = path.join(
      skipDir,
      ".gstack",
      "analytics",
      "build-runs.jsonl",
    );
    const analytics = fs
      .readFileSync(analyticsFile, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));

    expect(result.status).toBe(13); // FINALIZATION_REQUIRED: features stuck at origin_verified
    expect(out).toContain("--skip-ship active: shipping is disabled");
    expect(saved.features[0].status).toBe("origin_verified");
    expect(saved.features[1].status).toBe("origin_verified");
    expect(saved.features[0].branch).not.toBe(saved.features[1].branch);
    expect(saved.features[0].branch).toContain("ready");
    expect(saved.features[1].branch).toContain("also-ready");
    expect(saved.features[0].completedAt).toBeUndefined();
    expect(saved.features[1].completedAt).toBeUndefined();
    expect(saved.completed).toBe(false);
    expect(saved.launch.skipShip).toBe(true);
    expect(saved.launch.dryRun).toBe(false);
    expect(saved.launch.projectRoot).toBe(repo);
    expect(
      analytics.some(
        (event) => event.event === "start" && event.skipShip === true,
      ),
    ).toBe(true);
    expect(
      analytics.some(
        (event) => event.event === "success" && event.skipShip === true,
      ),
    ).toBe(true);
  } finally {
    fs.rmSync(skipDir, { recursive: true, force: true });
  }
});

test("exit-13 (FINALIZATION_REQUIRED) writes paused status to active-run registry", () => {
  const skipDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "gstack-exit13-registry-"),
  );
  try {
    const repo = path.join(skipDir, "repo");
    const bare = path.join(skipDir, "origin.git");
    fs.mkdirSync(repo);
    expect(spawnSync("git", ["init", "-b", "main"], { cwd: repo }).status).toBe(
      0,
    );
    expect(
      spawnSync("git", ["init", "--bare", "-b", "main", bare]).status,
    ).toBe(0);
    expect(
      spawnSync("git", ["config", "user.email", "test@example.com"], {
        cwd: repo,
      }).status,
    ).toBe(0);
    expect(
      spawnSync("git", ["config", "user.name", "Test User"], { cwd: repo })
        .status,
    ).toBe(0);
    fs.writeFileSync(path.join(repo, "README.md"), "# test\n");
    expect(spawnSync("git", ["add", "README.md"], { cwd: repo }).status).toBe(
      0,
    );
    expect(
      spawnSync("git", ["commit", "-m", "init"], { cwd: repo }).status,
    ).toBe(0);
    expect(
      spawnSync("git", ["remote", "add", "origin", bare], { cwd: repo }).status,
    ).toBe(0);
    expect(
      spawnSync("git", ["push", "-u", "origin", "main"], { cwd: repo }).status,
    ).toBe(0);

    const planFile = path.join(skipDir, "exit13-plan.md");
    fs.writeFileSync(
      planFile,
      `# Exit 13 Registry Plan

## Feature 1: Ready

### Phase 1.1: Done
- [x] **Test Specification (Gemini Sub-agent)**: Existing tests.
- [x] **Implementation (Gemini Sub-agent)**: Existing implementation.
- [x] **Review & QA (Codex Sub-agent)**: Existing review.
`,
    );

    const registryDir = path.join(
      skipDir,
      ".gstack",
      "build-state",
      "active-runs",
    );
    const runId = "test-exit13-run";

    const cliPath = path.resolve(import.meta.dir, "../cli.ts");
    const result = spawnSync(
      "bun",
      [
        "run",
        cliPath,
        planFile,
        "--project-root",
        repo,
        "--skip-ship",
        "--no-plan-review",
        "--test-cmd",
        "bun test",
        "--no-gbrain",
        "--run-id",
        runId,
        "--active-run-registry",
        registryDir,
      ],
      {
        env: {
          ...process.env,
          HOME: skipDir,
          GSTACK_HOME: path.join(skipDir, ".gstack"),
        },
        encoding: "utf8",
        timeout: 30_000,
      },
    );

    expect(result.status).toBe(13); // FINALIZATION_REQUIRED

    const records = fs
      .readdirSync(registryDir)
      .filter((f) => f.endsWith(".json"));
    expect(records.length).toBe(1);
    const record = JSON.parse(
      fs.readFileSync(path.join(registryDir, records[0]), "utf8"),
    );
    expect(record.status).toBe("paused"); // not "failed" — concurrency gate must treat exit-13 as non-terminal
  } finally {
    fs.rmSync(skipDir, { recursive: true, force: true });
  }
});

test("normal resume ships origin-verified features before starting later features", () => {
  const resumeDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "gstack-resume-ship-feature-"),
  );
  try {
    const repo = path.join(resumeDir, "repo");
    const bare = path.join(resumeDir, "origin.git");
    const binDir = path.join(resumeDir, "bin");
    const callsFile = path.join(resumeDir, "ship-calls.log");
    fs.mkdirSync(repo);
    fs.mkdirSync(binDir);
    expect(spawnSync("git", ["init", "-b", "main"], { cwd: repo }).status).toBe(
      0,
    );
    expect(
      spawnSync("git", ["init", "--bare", "-b", "main", bare]).status,
    ).toBe(0);
    expect(
      spawnSync("git", ["config", "user.email", "test@example.com"], {
        cwd: repo,
      }).status,
    ).toBe(0);
    expect(
      spawnSync("git", ["config", "user.name", "Test User"], { cwd: repo })
        .status,
    ).toBe(0);
    fs.writeFileSync(path.join(repo, "README.md"), "# test\n");
    expect(spawnSync("git", ["add", "README.md"], { cwd: repo }).status).toBe(
      0,
    );
    expect(
      spawnSync("git", ["commit", "-m", "init"], { cwd: repo }).status,
    ).toBe(0);
    expect(
      spawnSync("git", ["remote", "add", "origin", bare], { cwd: repo }).status,
    ).toBe(0);
    expect(
      spawnSync("git", ["push", "-u", "origin", "main"], { cwd: repo }).status,
    ).toBe(0);

    const featureBranches = [
      "feat/resume-plan-1-one",
      "feat/resume-plan-2-two",
    ];
    for (const [idx, branch] of featureBranches.entries()) {
      expect(
        spawnSync("git", ["checkout", "-b", branch, "main"], { cwd: repo })
          .status,
      ).toBe(0);
      fs.writeFileSync(
        path.join(repo, `feature-${idx + 1}.txt`),
        `feature ${idx + 1}\n`,
      );
      expect(
        spawnSync("git", ["add", `feature-${idx + 1}.txt`], { cwd: repo })
          .status,
      ).toBe(0);
      expect(
        spawnSync("git", ["commit", "-m", `feature ${idx + 1}`], { cwd: repo })
          .status,
      ).toBe(0);
    }
    expect(
      spawnSync("git", ["checkout", featureBranches[0]], { cwd: repo }).status,
    ).toBe(0);

    const ghPath = path.join(binDir, "gh");
    fs.writeFileSync(
      ghPath,
      '#!/bin/sh\nif [ "$1" = "pr" ] && [ "$2" = "list" ]; then echo 0; exit 0; fi\necho unexpected gh "$@" >&2\nexit 1\n',
      { mode: 0o755 },
    );
    const geminiPath = path.join(binDir, "gemini");
    fs.writeFileSync(
      geminiPath,
      `#!/bin/sh
set -eu
prompt=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-p" ]; then
    shift
    prompt="$1"
  fi
  shift || true
done
input=$(printf '%s\\n' "$prompt" | sed -n 's/.*Read instructions at \\(.*\\)\\. Run .*/\\1/p')
output=$(printf '%s\\n' "$prompt" | sed -n 's/.*Write your complete output to \\(.*\\)\\. Return.*/\\1/p')
branch=$(git rev-parse --abbrev-ref HEAD)
if grep -q '/ship' "$input"; then
  echo "ship:$branch" >> "$SHIP_CALLS_FILE"
  git checkout main >/dev/null 2>&1
  git merge --no-ff "$branch" -m "merge $branch" >/dev/null 2>&1
  git push origin main >/dev/null 2>&1
else
  echo "land:$branch" >> "$SHIP_CALLS_FILE"
fi
[ -n "$output" ] && printf 'ok\\n' > "$output"
`,
      { mode: 0o755 },
    );

    const resumePlanFile = path.join(resumeDir, "resume-plan.md");
    fs.writeFileSync(
      resumePlanFile,
      `# Resume Ship Plan

## Feature 1: One

### Phase 1.1: Done
- [x] **Test Specification (Gemini Sub-agent)**: Existing tests.
- [x] **Implementation (Gemini Sub-agent)**: Existing implementation.
- [x] **Review & QA (Codex Sub-agent)**: Existing review.

## Feature 2: Two

### Phase 2.1: Done
- [x] **Test Specification (Gemini Sub-agent)**: Existing tests.
- [x] **Implementation (Gemini Sub-agent)**: Existing implementation.
- [x] **Review & QA (Codex Sub-agent)**: Existing review.
`,
    );

    const stateDir = path.join(resumeDir, ".gstack", "build-state");
    fs.mkdirSync(stateDir, { recursive: true });
    const stateFile = path.join(stateDir, "build-resume-plan.json");
    const now = "2026-05-07T00:00:00.000Z";
    fs.writeFileSync(
      stateFile,
      JSON.stringify(
        {
          planFile: resumePlanFile,
          planBasename: "resume-plan",
          slug: "build-resume-plan",
          branch: featureBranches[0],
          startedAt: now,
          lastUpdatedAt: now,
          currentPhaseIndex: 0,
          currentFeatureIndex: 0,
          features: [
            {
              index: 0,
              number: "1",
              name: "One",
              phaseIndexes: [0],
              status: "origin_verified",
              branch: featureBranches[0],
              featureReview: {
                iterations: 1,
                outputLogPaths: [],
                outputFilePaths: [],
                finalVerdict: "FEATURE_PASS",
              },
            },
            {
              index: 1,
              number: "2",
              name: "Two",
              phaseIndexes: [1],
              status: "origin_verified",
              branch: featureBranches[1],
              featureReview: {
                iterations: 1,
                outputLogPaths: [],
                outputFilePaths: [],
                finalVerdict: "FEATURE_PASS",
              },
            },
          ],
          phases: [
            { index: 0, number: "1.1", name: "Done", status: "committed" },
            { index: 1, number: "2.1", name: "Done", status: "committed" },
          ],
          completed: false,
          geminiModel: "gemini",
          codexModel: "codex",
          codexReviewModel: "codex-review",
        },
        null,
        2,
      ),
    );

    const cliPath = path.resolve(import.meta.dir, "../cli.ts");
    const result = spawnSync(
      "bun",
      [
        "run",
        cliPath,
        resumePlanFile,
        "--project-root",
        repo,
        "--skip-clean-check",
        "--no-plan-review",
        "--no-gbrain",
        "--release-mode",
        "auto-land",
        "--ship-provider",
        "gemini",
        "--land-provider",
        "gemini",
        "--ship-command",
        "/ship",
        "--land-command",
        "/land-and-deploy",
      ],
      {
        env: {
          ...process.env,
          HOME: resumeDir,
          GSTACK_HOME: path.join(resumeDir, ".gstack"),
          PATH: `${binDir}:${process.env.PATH}`,
          GEMINI_BIN: geminiPath,
          SHIP_CALLS_FILE: callsFile,
        },
        encoding: "utf8",
        timeout: 60_000,
      },
    );

    const out = result.stdout + result.stderr;
    const saved = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    const calls = fs.readFileSync(callsFile, "utf8").trim().split("\n");
    const feature1Ship = out.indexOf(
      "[build-status] Feature 1 / ship-and-land",
    );
    const feature2Start = out.indexOf(
      "[build-status] Feature 2 / feature-start",
    );

    expect(result.status).toBe(0);
    expect(out).toContain(
      "[build-status] Feature 1 / feature-review — already passed",
    );
    expect(feature1Ship).toBeGreaterThanOrEqual(0);
    expect(feature2Start).toBeGreaterThan(feature1Ship);
    expect(calls).toEqual([
      `ship:${featureBranches[0]}`,
      "land:main",
      `ship:${featureBranches[1]}`,
      "land:main",
    ]);
    expect(
      saved.features.map((feature: { status: string }) => feature.status),
    ).toEqual(["committed", "committed"]);
    expect(saved.completed).toBe(true);
    expect(saved.launch.skipShip).toBe(false);
    expect(saved.launch.projectRoot).toBe(repo);
  } finally {
    fs.rmSync(resumeDir, { recursive: true, force: true });
  }
});

test("release_queued without shippedAt/prNumber is detected as manual patch and reset", () => {
  const patchedDir = fs.mkdtempSync(path.join(os.tmpdir(), "gstack-rq-patch-"));
  try {
    const repo = path.join(patchedDir, "repo");
    fs.mkdirSync(repo);
    expect(spawnSync("git", ["init", "-b", "main"], { cwd: repo }).status).toBe(
      0,
    );
    expect(
      spawnSync("git", ["config", "user.email", "test@example.com"], {
        cwd: repo,
      }).status,
    ).toBe(0);
    expect(
      spawnSync("git", ["config", "user.name", "Test User"], { cwd: repo })
        .status,
    ).toBe(0);
    fs.writeFileSync(path.join(repo, "README.md"), "# test\n");
    expect(spawnSync("git", ["add", "README.md"], { cwd: repo }).status).toBe(
      0,
    );
    expect(
      spawnSync("git", ["commit", "-m", "init"], { cwd: repo }).status,
    ).toBe(0);

    const patchedPlanFile = path.join(patchedDir, "release-queued-plan.md");
    fs.writeFileSync(
      patchedPlanFile,
      `# Release Queued Plan

## Feature 1: Patched

### Phase 1.1: Done
- [x] **Test Specification (Gemini Sub-agent)**: Existing tests.
- [x] **Implementation (Gemini Sub-agent)**: Existing implementation.
- [x] **Review & QA (Codex Sub-agent)**: Existing review.
`,
    );

    const stateDir = path.join(patchedDir, ".gstack", "build-state");
    fs.mkdirSync(stateDir, { recursive: true });
    const stateFile = path.join(stateDir, "build-release-queued-plan.json");
    const now = "2026-05-08T00:00:00.000Z";
    fs.writeFileSync(
      stateFile,
      JSON.stringify(
        {
          planFile: patchedPlanFile,
          planBasename: "release-queued-plan",
          slug: "build-release-queued-plan",
          branch: "main",
          startedAt: now,
          lastUpdatedAt: now,
          currentPhaseIndex: 0,
          currentFeatureIndex: 0,
          features: [
            {
              index: 0,
              number: "1",
              name: "Patched",
              phaseIndexes: [0],
              // Manual patch: status set to release_queued without shippedAt or prNumber.
              // The real ship pipeline sets both; without them, isFeatureTerminal() returns
              // false and the detection block must warn + reset.
              status: "release_queued",
            },
          ],
          phases: [
            { index: 0, number: "1.1", name: "Done", status: "committed" },
          ],
          completed: false,
          geminiModel: "gemini",
          codexModel: "codex",
          codexReviewModel: "codex-review",
        },
        null,
        2,
      ),
    );

    const cliPath = path.resolve(import.meta.dir, "../cli.ts");
    const result = spawnSync(
      "bun",
      [
        "run",
        cliPath,
        patchedPlanFile,
        "--project-root",
        repo,
        "--dry-run",
        "--test-cmd",
        "bun test",
        "--no-gbrain",
      ],
      {
        env: {
          ...process.env,
          HOME: patchedDir,
          GSTACK_HOME: path.join(patchedDir, ".gstack"),
        },
        encoding: "utf8",
        timeout: 30_000,
      },
    );

    const out = result.stdout + result.stderr;
    const saved = JSON.parse(fs.readFileSync(stateFile, "utf8"));

    // The detection block must warn about the missing evidence fields.
    expect(out).toContain("shippedAt/prNumber are missing");
    // The feature must NOT be stuck as release_queued. With --dry-run the pipeline
    // continues after the reset and the feature reaches origin_verified (ship skipped).
    expect(saved.features[0].status).toBe("origin_verified");
  } finally {
    fs.rmSync(patchedDir, { recursive: true, force: true });
  }
});

test("two same-basename plans with run ids cannot load each other's state", () => {
  const runDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "gstack-run-id-isolation-"),
  );
  try {
    const planADir = path.join(runDir, "a");
    const planBDir = path.join(runDir, "b");
    fs.mkdirSync(planADir, { recursive: true });
    fs.mkdirSync(planBDir, { recursive: true });
    const planA = path.join(planADir, "same-plan.md");
    const planB = path.join(planBDir, "same-plan.md");
    fs.writeFileSync(planA, TDD_PLAN);
    fs.writeFileSync(planB, TDD_PLAN.replace("Foundation", "Other Foundation"));
    const cliPath = path.resolve(import.meta.dir, "../cli.ts");
    const env = {
      ...process.env,
      HOME: runDir,
      GSTACK_HOME: path.join(runDir, ".gstack"),
    };

    const first = spawnSync(
      "bun",
      [
        "run",
        cliPath,
        planA,
        "--dry-run",
        "--run-id",
        "run-a",
        "--no-gbrain",
        "--no-resume",
      ],
      { env, encoding: "utf8", timeout: 30_000 },
    );
    const second = spawnSync(
      "bun",
      [
        "run",
        cliPath,
        planB,
        "--dry-run",
        "--run-id",
        "run-b",
        "--no-gbrain",
        "--no-resume",
      ],
      { env, encoding: "utf8", timeout: 30_000 },
    );

    expect(first.status).toBe(0);
    expect(second.status).toBe(0);
    const stateA = JSON.parse(
      fs.readFileSync(
        path.join(runDir, ".gstack", "build-state", "build-run-a.json"),
        "utf8",
      ),
    );
    const stateB = JSON.parse(
      fs.readFileSync(
        path.join(runDir, ".gstack", "build-state", "build-run-b.json"),
        "utf8",
      ),
    );
    expect(stateA.planFile).toBe(planA);
    expect(stateB.planFile).toBe(planB);
    expect(stateA.slug).toBe("build-run-a");
    expect(stateB.slug).toBe("build-run-b");
  } finally {
    fs.rmSync(runDir, { recursive: true, force: true });
  }
});

const FLAT_TASK_PLAN = `# Malformed Plan

### Phase 1: Test Specification
- [ ] Write failing E2E test for the control plane reconcile loop
- [ ] Confirm test fails in CI

### Phase 2: Implementation
- [ ] Edit helper module to add reconcile method
- [ ] Wire reconcile call into controller

### Phase 3: Review & QA
- [ ] Re-read diff against spec
- [ ] Run linter and fix warnings
`;

test("--print-only exits 2 when plan has no executable phases", () => {
  const cliPath = path.resolve(import.meta.dir, "../cli.ts");
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "gstack-malformed-"));
  try {
    const malformedPlan = path.join(runDir, "malformed-plan.md");
    fs.writeFileSync(malformedPlan, FLAT_TASK_PLAN);
    const result = spawnSync(
      "bun",
      ["run", cliPath, malformedPlan, "--print-only", "--no-gbrain"],
      {
        env: {
          ...process.env,
          HOME: runDir,
          GSTACK_HOME: path.join(runDir, ".gstack"),
        },
        encoding: "utf8",
        timeout: 30_000,
      },
    );
    expect(result.status).toBe(2);
    // Must emit the droppedPhasesCount hint even in --print-only mode,
    // distinguishing a malformed plan from a truly empty one.
    expect(result.stderr).toContain("3 phase(s) found but none are executable");
  } finally {
    fs.rmSync(runDir, { recursive: true, force: true });
  }
});

test("malformed flat-task plan exits 2 and stderr contains droppedPhasesCount hint", () => {
  const cliPath = path.resolve(import.meta.dir, "../cli.ts");
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "gstack-malformed-"));
  try {
    const malformedPlan = path.join(runDir, "malformed-plan.md");
    fs.writeFileSync(malformedPlan, FLAT_TASK_PLAN);
    const result = spawnSync(
      "bun",
      ["run", cliPath, malformedPlan, "--no-gbrain"],
      {
        env: {
          ...process.env,
          HOME: runDir,
          GSTACK_HOME: path.join(runDir, ".gstack"),
        },
        encoding: "utf8",
        timeout: 30_000,
      },
    );
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("3 phase(s) found but none are executable");
    expect(result.stderr).toContain("labeled markers");
  } finally {
    fs.rmSync(runDir, { recursive: true, force: true });
  }
});
