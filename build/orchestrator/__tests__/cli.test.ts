import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  buildGeminiTestSpecPrompt,
  buildDualImplPromptBody,
  buildCodexReviewBody,
  buildJudgePrompt,
  buildReviewGatePlan,
  isLikelyCodexWorkspaceSandboxFailure,
  isLikelyCodexContextWindowFailure,
  shouldRetryPrimaryImplWithSecondary,
  shouldRetryCodexGateWithDangerFullAccess,
  parseArgs,
  validateRoleProviders,
  resolveProjectRoot,
  validateProjectRootSelection,
  captureGitSnapshot,
  recoverMutableAgentCommit,
  validatePostAgentHygiene,
  validateParentWorkspaceUnchanged,
  hygieneFailureResult,
  archiveLivingPlan,
  archiveOriginPlan,
  buildOriginVerificationBody,
  ensureFeatureBranch,
  detectRemoteBaseRef,
  syncLandedBase,
  syncFeatureBranchWithBase,
  validateResumeLaunch,
  restartFeatureFromOriginIssues,
  markPhaseCommittedAfterManualRecovery,
  phaseTableStatus,
  phaseGateProjection,
  reconcileVisiblePlanState,
  releaseDaemonLaunchCommand,
  renderLaunchdReleaseDaemonPlist,
  renderSystemdReleaseDaemonService,
  HELP_TEXT,
} from "../cli";
import type {
  BuildState,
  FeatureState,
  Feature,
  Phase,
  PhaseState,
  DualImplTestResult,
} from "../types";
import { lockPath, statePath } from "../state";
import { _testWritePlan } from "../plan-mutator";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { DEFAULT_ROLE_CONFIGS } from "../role-config";

let tmpDir: string | null = null;
let tmpStateDir: string | null = null;
let realStateDir: string | undefined;

beforeEach(() => {
  realStateDir = process.env.GSTACK_BUILD_STATE_DIR;
  tmpStateDir = fs.mkdtempSync(path.join(os.tmpdir(), "gstack-cli-state-"));
  process.env.GSTACK_BUILD_STATE_DIR = tmpStateDir;
});

afterEach(() => {
  if (realStateDir) process.env.GSTACK_BUILD_STATE_DIR = realStateDir;
  else delete process.env.GSTACK_BUILD_STATE_DIR;
  if (tmpStateDir && fs.existsSync(tmpStateDir)) {
    fs.rmSync(tmpStateDir, { recursive: true, force: true });
  }
  if (tmpDir && fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
  tmpStateDir = null;
  tmpDir = null;
});

const basePhase: Phase = {
  index: 0,
  number: "1",
  name: "Auth middleware",
  featureIndex: 0,
  featureNumber: "1",
  featureName: "Auth",
  body: "Write tests for the auth middleware.",
  testSpecDone: false,
  testSpecCheckboxLine: 5,
  implementationCheckboxLine: 6,
  reviewCheckboxLine: 7,
  implementationDone: false,
  reviewDone: false,
  dualImpl: false,
};

function expectParseArgsExit(argv: string[], message: string): void {
  const originalExit = process.exit;
  const originalError = console.error;
  const errors: string[] = [];
  console.error = (msg?: unknown) => {
    errors.push(String(msg));
  };
  process.exit = ((code?: number) => {
    throw new Error(`exit:${code}`);
  }) as never;
  try {
    expect(() => parseArgs(argv)).toThrow("exit:2");
    expect(errors.join("\n")).toContain(message);
  } finally {
    process.exit = originalExit;
    console.error = originalError;
  }
}

describe("buildGeminiTestSpecPrompt", () => {
  it('contains "write failing tests"', () => {
    const prompt = buildGeminiTestSpecPrompt(basePhase, "plan.md");
    expect(prompt.toLowerCase()).toContain("write failing tests");
  });

  it('contains "do NOT implement" or "do not implement"', () => {
    const prompt = buildGeminiTestSpecPrompt(basePhase, "plan.md");
    expect(prompt.toLowerCase()).toMatch(/do not implement/);
  });

  it("contains the phase name", () => {
    const prompt = buildGeminiTestSpecPrompt(basePhase, "plan.md");
    expect(prompt).toContain(basePhase.name);
  });

  it("contains the plan file path", () => {
    const prompt = buildGeminiTestSpecPrompt(basePhase, "plan.md");
    expect(prompt).toContain("plan.md");
  });

  it("tells test writers not to substitute submodules for missing components", () => {
    const prompt = buildGeminiTestSpecPrompt(basePhase, "plan.md");
    expect(prompt).toContain("do not edit git submodules");
    expect(prompt).toContain("report a plan mismatch");
  });
});

describe("--dual-impl flag wiring", () => {
  it("--help text mentions --dual-impl", () => {
    expect(HELP_TEXT).toContain("--dual-impl");
  });

  it("parseArgs([plan, --dual-impl]) sets dualImpl=true when judge is Claude-compatible", () => {
    const args = parseArgs([
      "plan.md",
      "--dual-impl",
      "--primary-impl-provider",
      "gemini",
      "--judge-provider",
      "claude",
    ]);
    expect(args.dualImpl).toBe(true);
  });

  it("parseArgs default -> dualImpl=false", () => {
    const args = parseArgs(["plan.md"]);
    expect(args.dualImpl).toBe(false);
  });
});

describe("--skip-ship flag wiring", () => {
  it("parseArgs default -> skipShip=false", () => {
    const args = parseArgs(["plan.md"]);
    expect(args.skipShip).toBe(false);
  });

  it("parseArgs([plan, --skip-ship]) sets skipShip=true", () => {
    const args = parseArgs(["plan.md", "--skip-ship"]);
    expect(args.skipShip).toBe(true);
  });

  it("parseArgs default release mode is queued and preserves --skip-ship", () => {
    const args = parseArgs(["plan.md", "--skip-ship"]);
    expect(args.releaseMode).toBe("queued");
    expect(args.skipShip).toBe(true);
  });

  it("parseArgs supports legacy auto-land release mode", () => {
    const args = parseArgs(["plan.md", "--release-mode", "auto-land"]);
    expect(args.releaseMode).toBe("auto-land");
  });

  it("rejects invalid release modes", () => {
    expectParseArgsExit(
      ["plan.md", "--release-mode", "surprise"],
      "--release-mode expects queued or auto-land",
    );
  });
});

describe("release-daemon CLI", () => {
  it("parses release-daemon run defaults", () => {
    const args = parseArgs(["release-daemon", "run"]);
    expect(args.mode).toBe("release-daemon");
    expect(args.releaseDaemonCommand).toBe("run");
    expect(args.releaseDaemonOnce).toBe(true);
    expect(args.releaseDaemonPollMs).toBe(30_000);
  });

  it("parses release-daemon watch and retry", () => {
    const watch = parseArgs(["release-daemon", "run", "--watch", "--poll-ms", "5"]);
    expect(watch.releaseDaemonWatch).toBe(true);
    expect(watch.releaseDaemonPollMs).toBe(5);

    const retry = parseArgs(["release-daemon", "retry", "42"]);
    expect(retry.releaseDaemonCommand).toBe("retry");
    expect(retry.releaseDaemonRetryPr).toBe(42);
  });

  it("renders repo-aware daemon install commands for launchd and systemd", () => {
    const command = releaseDaemonLaunchCommand("/Users/alice/project repo");
    expect(command).toContain("--project-root");
    expect(command).toContain("/Users/alice/project repo");

    const plist = renderLaunchdReleaseDaemonPlist(command, "/Users/alice/project repo");
    expect(plist).toContain("<key>WorkingDirectory</key><string>/Users/alice/project repo</string>");
    expect(plist).toContain("<string>--project-root</string>");

    const service = renderSystemdReleaseDaemonService(command, "/Users/alice/project repo");
    expect(service).toContain("WorkingDirectory=/Users/alice/project\\ repo");
    expect(service).toContain("--project-root /Users/alice/project\\ repo");
  });
});

describe("manual recovery flags", () => {
  it("help text documents manual phase and submodule recovery flags", () => {
    expect(HELP_TEXT).toContain("--allow-submodule-recovery");
    expect(HELP_TEXT).toContain("--mark-phase-committed");
  });

  it("parses --allow-submodule-recovery and --mark-phase-committed", () => {
    const args = parseArgs([
      "plan.md",
      "--allow-submodule-recovery",
      "op-node",
      "--mark-phase-committed",
      "2.3",
    ]);
    expect(args.allowSubmoduleRecovery).toEqual(["op-node"]);
    expect(args.markPhaseCommitted).toBe("2.3");
  });
});

describe("lock cleanup", () => {
  it("releases the run lock if provisional active-run registration fails before state exists", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gstack-lock-cleanup-"));
    spawnSync("git", ["init", "--initial-branch=main"], {
      cwd: tmpDir,
      stdio: "ignore",
    });
    spawnSync("git", ["config", "user.email", "test@example.com"], {
      cwd: tmpDir,
    });
    spawnSync("git", ["config", "user.name", "Test User"], { cwd: tmpDir });
    fs.writeFileSync(path.join(tmpDir, "app.ts"), "export const ok = true;\n");
    spawnSync("git", ["add", "."], { cwd: tmpDir });
    spawnSync("git", ["commit", "-m", "initial"], {
      cwd: tmpDir,
      stdio: "ignore",
    });

    const plan = path.join(tmpDir, "plan.md");
    fs.writeFileSync(
      plan,
      `# Plan

## Features

### Feature 1: Lock cleanup

## Phases

### Phase 1: Lock cleanup
- [ ] **Test Specification (Gemini Sub-agent)**: Write failing tests.
- [ ] **Implementation (Codex Sub-agent)**: Implement the fix.
- [ ] **Review (Codex Review Sub-agent)**: Review the implementation.
`,
    );
    const registryParentFile = path.join(tmpDir, "registry-parent");
    fs.writeFileSync(registryParentFile, "not a directory\n");
    const impossibleRegistry = path.join(registryParentFile, "active-runs");

    const result = spawnSync(
      process.execPath,
      [
        path.resolve("build/orchestrator/cli.ts"),
        plan,
        "--project-root",
        tmpDir,
        "--dry-run",
        "--run-id",
        "lock-cleanup",
        "--branch-prefix",
        "lock-cleanup",
        "--active-run-registry",
        impossibleRegistry,
        "--no-gbrain",
      ],
      {
        cwd: path.resolve("."),
        encoding: "utf8",
        env: {
          ...process.env,
          GSTACK_BUILD_STATE_DIR: tmpStateDir!,
        },
      },
    );

    expect(result.status).not.toBe(0);
    expect(fs.existsSync(lockPath("build-lock-cleanup"))).toBe(false);
  });
});

describe("merge subcommand wiring", () => {
  it("parseArgs([merge]) selects merge mode without a plan file", () => {
    const args = parseArgs(["merge"]);
    expect(args.mode).toBe("merge");
    expect(args.planFile).toBe("");
  });

  it("--help text documents merge mode", () => {
    expect(HELP_TEXT).toContain("gstack-build merge [flags]");
    expect(HELP_TEXT).toContain(
      "Review/fix/ship/land unmerged feat/* branches",
    );
  });
});

describe("monitor subcommand wiring", () => {
  it("parseArgs([monitor, --manifest, file, --once]) selects monitor mode", () => {
    const manifest = path.join(os.tmpdir(), "manifest.json");
    const args = parseArgs(["monitor", "--manifest", manifest, "--once"]);
    expect(args.mode).toBe("monitor");
    expect(args.monitorManifest).toBe(path.resolve(manifest));
    expect(args.monitorOnce).toBe(true);
  });

  it("--help text documents monitor mode and exit codes", () => {
    expect(HELP_TEXT).toContain("gstack-build monitor --manifest <path>");
    expect(HELP_TEXT).toContain("HOST_CONTEXT_SAVE_REQUIRED");
    expect(HELP_TEXT).toContain("MONITOR_REENTER");
  });

  it("--watch and --once are mutually exclusive", () => {
    expectParseArgsExit(
      ["monitor", "--manifest", "manifest.json", "--once", "--watch"],
      "only one of --once or --watch",
    );
  });

  it("rejects monitor-only flags outside monitor mode", () => {
    expectParseArgsExit(["plan.md", "--once"], "monitor flags require");
    expectParseArgsExit(
      ["merge", "--manifest", "manifest.json"],
      "monitor flags require",
    );
  });

  it("monitor --once emits final JSON and exits with mapped code", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gstack-monitor-cli-"));
    const runId = "cli-run";
    const stateSlug = `build-${runId}`;
    const repoPath = path.join(tmpDir, "repo");
    const worktreePath = path.join(tmpDir, "worktree");
    const livingPlanPath = path.join(tmpDir, "living.md");
    const manifestPath = path.join(tmpDir, "manifest.json");
    fs.mkdirSync(worktreePath, { recursive: true });
    const activeRunRegistry = path.join(tmpDir, "active-runs");
    fs.mkdirSync(path.join(tmpStateDir!, stateSlug), { recursive: true });
    fs.writeFileSync(
      path.join(tmpStateDir!, stateSlug, ".host-context-save-count"),
      "1\n",
    );
    fs.writeFileSync(
      path.join(tmpStateDir!, `${stateSlug}.json`),
      JSON.stringify({
        planFile: livingPlanPath,
        planBasename: "living",
        slug: stateSlug,
        branch: "feat/cli",
        startedAt: "2026-05-08T00:00:00.000Z",
        lastUpdatedAt: "2026-05-08T00:00:00.000Z",
        launch: {
          argv: ["/bin/sh", "-c", "echo resume"],
          projectRoot: worktreePath,
          baseProjectRoot: repoPath,
          runId,
          branchPrefix: "repo-cli-run",
          activeRunRegistry,
          stateSlug,
          dryRun: false,
          skipShip: false,
          skipFeatureReview: false,
          launchedAt: "2026-05-08T00:00:00.000Z",
        },
        currentPhaseIndex: 0,
        currentFeatureIndex: -1,
        features: [],
        phases: [{ index: 0, number: "1", name: "Phase", status: "committed" }],
        completed: true,
      }),
    );
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({
        manifestId: "m",
        runGroupId: "g",
        tmpDir,
        runs: [
          {
            runId,
            repoPath,
            repoSlug: "repo",
            livingPlanPath,
            worktreePath,
            stateSlug,
            branchPrefix: "repo-cli-run",
            pidFile: path.join(tmpDir, "pid"),
            stdoutLog: path.join(tmpDir, "stdout.log"),
            launchCommand: [
              "/bin/echo",
              "resume",
              "--active-run-registry",
              activeRunRegistry,
            ],
            launchEnv: {},
          },
        ],
      }),
    );

    const result = spawnSync(
      process.execPath,
      [
        path.resolve("build/orchestrator/cli.ts"),
        "monitor",
        "--manifest",
        manifestPath,
        "--once",
      ],
      {
        cwd: path.resolve("."),
        encoding: "utf8",
        env: { ...process.env, GSTACK_BUILD_STATE_DIR: tmpStateDir! },
      },
    );

    expect(result.status).toBe(0);
    const lastLine = result.stdout.trim().split("\n").at(-1)!;
    expect(JSON.parse(lastLine).event).toBe("ALL_RUNS_COMPLETE");
  });

  it("monitor --watch exits MONITOR_REENTER at max wall time", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gstack-monitor-watch-"));
    const manifestPath = path.join(tmpDir, "manifest.json");
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({
        manifestId: "m",
        runGroupId: "g",
        tmpDir,
        runs: [
          {
            runId: "watch-run",
            repoPath: path.join(tmpDir, "repo"),
            repoSlug: "repo",
            livingPlanPath: path.join(tmpDir, "living.md"),
            worktreePath: path.join(tmpDir, "worktree"),
            stateSlug: "build-watch-run",
            branchPrefix: "repo-watch-run",
            pidFile: path.join(tmpDir, "pid"),
            stdoutLog: path.join(tmpDir, "stdout.log"),
            launchCommand: ["/bin/sh", "-c", "echo resume"],
            launchEnv: {},
          },
        ],
      }),
    );

    const result = spawnSync(
      process.execPath,
      [
        path.resolve("build/orchestrator/cli.ts"),
        "monitor",
        "--manifest",
        manifestPath,
        "--watch",
        "--poll-ms",
        "1",
        "--max-wall-ms",
        "1",
      ],
      {
        cwd: path.resolve("."),
        encoding: "utf8",
        env: { ...process.env, GSTACK_BUILD_STATE_DIR: tmpStateDir! },
      },
    );

    expect(result.status).toBe(12);
    expect(result.stdout).toContain("MONITOR_REENTER");
  });

  it("monitor --watch stays in the foreground after auto-resuming a stale run", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gstack-monitor-resume-"));
    const runId = "resume-run";
    const stateSlug = `build-${runId}`;
    const repoPath = path.join(tmpDir, "repo");
    const worktreePath = path.join(tmpDir, "worktree");
    const livingPlanPath = path.join(tmpDir, "living.md");
    const manifestPath = path.join(tmpDir, "manifest.json");
    fs.mkdirSync(worktreePath, { recursive: true });
    fs.writeFileSync(
      path.join(tmpStateDir!, `${stateSlug}.json`),
      JSON.stringify({
        planFile: livingPlanPath,
        planBasename: "living",
        slug: stateSlug,
        branch: "feat/resume",
        startedAt: "2000-01-01T00:00:00.000Z",
        lastUpdatedAt: "2000-01-01T00:00:00.000Z",
        launch: {
          argv: ["/bin/sh", "-c", "echo resume"],
          projectRoot: worktreePath,
          baseProjectRoot: repoPath,
          runId,
          branchPrefix: "repo-resume-run",
          activeRunRegistry: path.join(tmpDir, "active-runs"),
          stateSlug,
          dryRun: false,
          skipShip: false,
          skipFeatureReview: false,
          launchedAt: "2000-01-01T00:00:00.000Z",
        },
        currentPhaseIndex: 0,
        currentFeatureIndex: -1,
        features: [],
        phases: [{ index: 0, number: "1", name: "Phase", status: "pending" }],
        completed: false,
      }),
    );
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({
        manifestId: "m",
        runGroupId: "g",
        tmpDir,
        runs: [
          {
            runId,
            repoPath,
            repoSlug: "repo",
            livingPlanPath,
            worktreePath,
            stateSlug,
            branchPrefix: "repo-resume-run",
            pidFile: path.join(tmpDir, "pid"),
            stdoutLog: path.join(tmpDir, "stdout.log"),
            launchCommand: ["/bin/sh", "-c", "echo resume"],
            launchEnv: {},
          },
        ],
      }),
    );

    const result = spawnSync(
      process.execPath,
      [
        path.resolve("build/orchestrator/cli.ts"),
        "monitor",
        "--manifest",
        manifestPath,
        "--watch",
        "--poll-ms",
        "1",
        "--max-wall-ms",
        "5",
      ],
      {
        cwd: path.resolve("."),
        encoding: "utf8",
        env: { ...process.env, GSTACK_BUILD_STATE_DIR: tmpStateDir! },
      },
    );

    expect(result.status).toBe(12);
    expect(result.stdout).toContain("RUN_RESUMED");
    expect(result.stdout).toContain("MONITOR_REENTER");
  });
});

describe("review gate planning", () => {
  it("skips reviewSecondary when its command is unset", () => {
    const roles = {
      ...DEFAULT_ROLE_CONFIGS,
      reviewSecondary: {
        ...DEFAULT_ROLE_CONFIGS.reviewSecondary,
        command: undefined,
      },
    };

    const plan = buildReviewGatePlan(roles);

    expect(plan.gates.map((g) => g.name)).toEqual(["review", "qa"]);
    expect(plan.skipped).toEqual([
      {
        name: "reviewSecondary",
        reason:
          "reviewSecondary command unset; skipped optional secondary review",
      },
    ]);
  });

  it("fails required review and QA gates when their commands are unset", () => {
    const roles = {
      ...DEFAULT_ROLE_CONFIGS,
      review: { ...DEFAULT_ROLE_CONFIGS.review, command: undefined },
      reviewSecondary: {
        ...DEFAULT_ROLE_CONFIGS.reviewSecondary,
        command: "/custom second opinion",
      },
      qa: { ...DEFAULT_ROLE_CONFIGS.qa, command: undefined },
    };

    const plan = buildReviewGatePlan(roles);

    expect(plan.gates.map((g) => g.name)).toEqual(["reviewSecondary"]);
    expect(plan.missingRequired).toEqual(["review", "qa"]);
  });
});

describe("Codex review gate sandbox retry classification", () => {
  it("detects local browser/process permission failures from workspace-write", () => {
    expect(
      isLikelyCodexWorkspaceSandboxFailure({
        stdout:
          "Chromium failed: mach_port_rendezvous_mac.cc Permission denied (1100). GATE FAIL",
        stderr: "",
      }),
    ).toBe(true);
  });

  it("detects localhost bind permission failures", () => {
    expect(
      isLikelyCodexWorkspaceSandboxFailure({
        stdout: "",
        stderr: "grpc server cannot bind localhost:50051: EACCES",
      }),
    ).toBe(true);
  });

  it("does not classify Codex service network disconnects as sandbox failures", () => {
    expect(
      isLikelyCodexWorkspaceSandboxFailure({
        stdout: "GATE FAIL",
        stderr:
          "ERROR: stream disconnected before completion: tls handshake eof while sending request to backend-api/codex/responses",
      }),
    ).toBe(false);
  });

  it("only retries Codex gates when sandbox env is not explicit", () => {
    const result = {
      stdout: "Playwright browser launch failed: Operation not permitted",
      stderr: "",
    };

    expect(
      shouldRetryCodexGateWithDangerFullAccess({
        role: { provider: "codex" },
        result,
      }),
    ).toBe(true);
    expect(
      shouldRetryCodexGateWithDangerFullAccess({
        role: { provider: "codex" },
        result,
        reviewSandboxEnv: "workspace-write",
      }),
    ).toBe(false);
    expect(
      shouldRetryCodexGateWithDangerFullAccess({
        role: { provider: "claude" },
        result,
      }),
    ).toBe(false);
  });
});

describe("Codex primary implementor context overflow fallback", () => {
  const primaryRole = {
    provider: "codex",
    model: "gpt-5.3-codex-spark",
    reasoning: "high",
  } as const;
  const secondaryRole = {
    provider: "gemini",
    model: "gemini-2.5-pro",
    reasoning: "high",
  } as const;

  it("detects Codex context-window overflow errors", () => {
    expect(
      isLikelyCodexContextWindowFailure({
        stdout: "",
        stderr:
          "ERROR: Codex ran out of room in the model's context window. Start a new thread or clear earlier history before retrying.",
      }),
    ).toBe(true);
  });

  it("retries a clean failed primary implementation with the configured secondary implementor", () => {
    expect(
      shouldRetryPrimaryImplWithSecondary({
        primaryRole,
        secondaryRole,
        result: {
          stdout: "",
          stderr: "ERROR: Codex ran out of room in the model's context window.",
          exitCode: 1,
          timedOut: false,
        },
        hasDirtyChanges: false,
      }),
    ).toBe(true);
  });

  it("does not retry when the failed primary already changed files", () => {
    expect(
      shouldRetryPrimaryImplWithSecondary({
        primaryRole,
        secondaryRole,
        result: {
          stdout: "",
          stderr: "ERROR: Codex ran out of room in the model's context window.",
          exitCode: 1,
          timedOut: false,
        },
        hasDirtyChanges: true,
      }),
    ).toBe(false);
  });
});

describe("--parallel-phases flag wiring", () => {
  it("--help text mentions --parallel-phases", () => {
    expect(HELP_TEXT).toContain("--parallel-phases");
  });

  it("parseArgs default -> parallelPhases=1", () => {
    const args = parseArgs(["plan.md"]);
    expect(args.parallelPhases).toBe(1);
  });

  it("parseArgs([plan, --parallel-phases, 3]) sets parallelPhases=3", () => {
    const args = parseArgs(["plan.md", "--parallel-phases", "3"]);
    expect(args.parallelPhases).toBe(3);
  });

  it("parseArgs rejects --parallel-phases below 1", () => {
    const originalExit = process.exit;
    const originalError = console.error;
    console.error = () => {};
    process.exit = ((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never;
    try {
      expect(() => parseArgs(["plan.md", "--parallel-phases", "0"])).toThrow(
        "exit:2",
      );
    } finally {
      process.exit = originalExit;
      console.error = originalError;
    }
  });

  it("parseArgs rejects combining --parallel-phases with --dual-impl", () => {
    const originalExit = process.exit;
    const originalError = console.error;
    console.error = () => {};
    process.exit = ((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never;
    try {
      expect(() =>
        parseArgs(["plan.md", "--dual-impl", "--parallel-phases", "2"]),
      ).toThrow("exit:2");
    } finally {
      process.exit = originalExit;
      console.error = originalError;
    }
  });
});

describe("--skip-clean-check / --skip-sweep flags", () => {
  it("parseArgs default -> skipCleanCheck=false, skipSweep=false", () => {
    const args = parseArgs(["plan.md"]);
    expect(args.skipCleanCheck).toBe(false);
    expect(args.skipSweep).toBe(false);
  });

  it("parseArgs([plan, --skip-clean-check]) -> skipCleanCheck=true", () => {
    const args = parseArgs(["plan.md", "--skip-clean-check"]);
    expect(args.skipCleanCheck).toBe(true);
  });

  it("parseArgs([plan, --skip-sweep]) -> skipSweep=true", () => {
    const args = parseArgs(["plan.md", "--skip-sweep"]);
    expect(args.skipSweep).toBe(true);
  });

  it("HELP_TEXT contains --skip-clean-check", () => {
    expect(HELP_TEXT).toContain("--skip-clean-check");
  });

  it("HELP_TEXT contains --skip-sweep", () => {
    expect(HELP_TEXT).toContain("--skip-sweep");
  });

  it("parseArgs rejects removed context-save CLI flags", () => {
    expect(parseArgs(["plan.md"])).not.toHaveProperty("skipContextSave");
    expect(HELP_TEXT).not.toContain("--skip-context-save");
    expect(HELP_TEXT).not.toContain("--context-save-model");
    expectParseArgsExit(
      ["plan.md", "--skip-context-save"],
      "unknown flag: --skip-context-save",
    );
    expectParseArgsExit(
      ["plan.md", "--context-save-model", "model-under-test"],
      "unknown flag: --context-save-model",
    );
  });
});

describe("--gemini-model / --codex-model flag wiring", () => {
  it("--help text mentions --gemini-model", () => {
    expect(HELP_TEXT).toContain("--gemini-model");
  });

  it("--help text mentions --codex-model", () => {
    expect(HELP_TEXT).toContain("--codex-model");
  });

  it("parseArgs with --gemini-model sets geminiModel", () => {
    const args = parseArgs([
      "plan.md",
      "--gemini-model",
      "primary-model-under-test",
    ]);
    expect(args.geminiModel).toBe("primary-model-under-test");
  });
  it("parseArgs accepts manifest run identity flags", () => {
    const registry = path.join(os.tmpdir(), "active-runs");
    const args = parseArgs([
      "plan.md",
      "--run-id",
      "run-1",
      "--base-project-root",
      ".",
      "--branch-prefix",
      "repo-run-1",
      "--active-run-registry",
      registry,
    ]);
    expect(args.runId).toBe("run-1");
    expect(args.baseProjectRoot).toBe(path.resolve("."));
    expect(args.branchPrefix).toBe("repo-run-1");
    expect(args.activeRunRegistry).toBe(path.resolve(registry));
  });

  it("parseArgs with --codex-model sets codexModel", () => {
    const args = parseArgs([
      "plan.md",
      "--codex-model",
      "secondary-model-under-test",
    ]);
    expect(args.codexModel).toBe("secondary-model-under-test");
  });

  it("parseArgs default -> model defaults come from configure.cm (no flags needed)", () => {
    const args = parseArgs(["plan.md"]);
    expect(args.geminiModel).toBe(DEFAULT_ROLE_CONFIGS.primaryImpl.model);
    expect(args.codexModel).toBe(DEFAULT_ROLE_CONFIGS.secondaryImpl.model);
    expect(args.codexReviewModel).toBe(
      DEFAULT_ROLE_CONFIGS.reviewSecondary.model,
    );
    expect(args.roles.testWriter).toEqual(DEFAULT_ROLE_CONFIGS.testWriter);
    expect(args.roles.testFixer).toEqual(DEFAULT_ROLE_CONFIGS.testFixer);
    expect(args.roles.ship).toEqual(DEFAULT_ROLE_CONFIGS.ship);
  });

  it("--codex-review-model overrides the review model default", () => {
    const args = parseArgs([
      "plan.md",
      "--codex-review-model",
      "review-model-under-test",
    ]);
    expect(args.codexReviewModel).toBe("review-model-under-test");
  });

  it("--help text mentions --codex-review-model", () => {
    expect(HELP_TEXT).toContain("--codex-review-model");
  });

  it("parseArgs accepts all three model flags together", () => {
    const args = parseArgs([
      "plan.md",
      "--gemini-model",
      "primary-model-under-test",
      "--codex-model",
      "secondary-model-under-test",
      "--codex-review-model",
      "review-model-under-test",
    ]);
    expect(args.geminiModel).toBe("primary-model-under-test");
    expect(args.codexModel).toBe("secondary-model-under-test");
    expect(args.codexReviewModel).toBe("review-model-under-test");
  });

  it("parseArgs model flags combine correctly with --dual-impl", () => {
    const args = parseArgs([
      "plan.md",
      "--dual-impl",
      "--primary-impl-provider",
      "gemini",
      "--judge-provider",
      "claude",
    ]);
    expect(args.dualImpl).toBe(true);
    expect(args.geminiModel).toBe(DEFAULT_ROLE_CONFIGS.primaryImpl.model);
    expect(args.codexModel).toBe(DEFAULT_ROLE_CONFIGS.secondaryImpl.model);
    expect(args.codexReviewModel).toBe(
      DEFAULT_ROLE_CONFIGS.reviewSecondary.model,
    );
  });

  it("new role flags override defaults", () => {
    const args = parseArgs([
      "plan.md",
      "--review-secondary-model",
      "review-secondary-model-under-test",
      "--review-secondary-command",
      "/custom second opinion",
      "--ship-model",
      "ship-model-under-test",
      "--ship-reasoning",
      "medium",
    ]);
    expect(args.roles.reviewSecondary.model).toBe(
      "review-secondary-model-under-test",
    );
    expect(args.roles.reviewSecondary.command).toBe("/custom second opinion");
    expect(args.roles.ship.model).toBe("ship-model-under-test");
    expect(args.roles.ship.reasoning).toBe("medium");
  });

  it("--project-root resolves to an absolute path", () => {
    const args = parseArgs(["plan.md", "--project-root", "."]);
    expect(path.isAbsolute(args.projectRoot!)).toBe(true);
  });

  it("--allow-workspace-root defaults false and can be enabled explicitly", () => {
    expect(parseArgs(["plan.md"]).allowWorkspaceRoot).toBe(false);
    expect(
      parseArgs(["plan.md", "--allow-workspace-root"]).allowWorkspaceRoot,
    ).toBe(true);
  });

  it("provider validation rejects unsupported slash-command providers but allows model-agnostic dual-impl", () => {
    const args = parseArgs([
      "plan.md",
      "--dual-impl",
      "--primary-impl-provider",
      "gemini",
      "--judge-provider",
      "claude",
    ]);
    args.roles.qa.provider = "kimi";
    args.roles.ship.provider = "gemini";
    args.roles.land.provider = "gemini";
    args.roles.primaryImpl.provider = "codex";
    args.roles.secondaryImpl.provider = "claude";
    args.roles.judge.provider = "codex";

    expect(validateRoleProviders(args)).toEqual([
      "--qa-provider kimi is not supported for slash-command gates",
    ]);
  });

  it("provider validation accepts non-Gemini/Codex/Claude dual-impl roles", () => {
    const args = parseArgs([
      "plan.md",
      "--dual-impl",
      "--primary-impl-provider",
      "codex",
      "--secondary-impl-provider",
      "claude",
      "--judge-provider",
      "gemini",
    ]);
    expect(validateRoleProviders(args)).toEqual([]);
  });
});

describe("phase table display", () => {
  it("prints completed phases as committed, matching persisted state values", () => {
    expect(
      phaseTableStatus({
        ...basePhase,
        testSpecDone: true,
        implementationDone: true,
        reviewDone: true,
      }),
    ).toBe("committed");
  });
});

describe("post-agent hygiene helpers", () => {
  function git(args: string[], cwd: string) {
    const r = spawnSync("git", args, { cwd, encoding: "utf8" });
    if (r.status !== 0) {
      throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
    }
    return r.stdout.trim();
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gstack-hygiene-"));
    git(["init", "--initial-branch=main"], tmpDir);
    git(["config", "user.email", "test@test.com"], tmpDir);
    git(["config", "user.name", "Test User"], tmpDir);
    fs.writeFileSync(path.join(tmpDir, "README.md"), "init\n");
    git(["add", "."], tmpDir);
    git(["commit", "-m", "init"], tmpDir);
  });

  it("rejects a successful implementor run with an empty summary", () => {
    const before = captureGitSnapshot(tmpDir!);
    const summary = path.join(tmpDir!, ".llm-tmp", "summary.md");
    fs.mkdirSync(path.dirname(summary), { recursive: true });
    fs.writeFileSync(summary, "");
    fs.writeFileSync(path.join(tmpDir!, "change.txt"), "change\n");
    git(["add", "."], tmpDir!);
    git(["commit", "-m", "change"], tmpDir!);

    const verdict = validatePostAgentHygiene({
      cwd: tmpDir!,
      before,
      outputFilePath: summary,
      requireNonEmptyOutput: true,
      requireNewCommit: true,
      label: "primary implementor",
    });

    expect(verdict.ok).toBe(false);
    expect(verdict.errors.join("\n")).toMatch(/empty output summary/);
  });

  it("rejects a successful implementor run that leaves an untracked file and no commit", () => {
    const before = captureGitSnapshot(tmpDir!);
    const summary = path.join(tmpDir!, ".llm-tmp", "summary.md");
    fs.mkdirSync(path.dirname(summary), { recursive: true });
    fs.writeFileSync(summary, "done\n");
    fs.writeFileSync(path.join(tmpDir!, "rewrite.py"), 'print("oops")\n');

    const verdict = validatePostAgentHygiene({
      cwd: tmpDir!,
      before,
      outputFilePath: summary,
      requireNonEmptyOutput: true,
      requireNewCommit: true,
      label: "primary implementor",
    });

    expect(verdict.ok).toBe(false);
    expect(verdict.errors.join("\n")).toMatch(/did not create a new commit/);
    expect(verdict.errors.join("\n")).toMatch(/\?\? rewrite\.py/);
  });

  it("recovers a sandboxed implementor by host-committing summary-listed files and cleaning cache noise", () => {
    fs.mkdirSync(path.join(tmpDir!, "pkg", "__pycache__"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir!, "pkg", "__pycache__", "mod.pyc"),
      "old-cache\n",
    );
    git(["add", "pkg/__pycache__/mod.pyc"], tmpDir!);
    git(["commit", "-m", "track cache fixture"], tmpDir!);

    const before = captureGitSnapshot(tmpDir!);
    const summary = path.join(tmpDir!, ".llm-tmp", "summary.md");
    fs.mkdirSync(path.dirname(summary), { recursive: true });
    fs.mkdirSync(path.join(tmpDir!, "src"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir!, "README.md"), "changed\n");
    fs.writeFileSync(
      path.join(tmpDir!, "src", "feature.ts"),
      "export const x = 1;\n",
    );
    fs.writeFileSync(
      path.join(tmpDir!, "pkg", "__pycache__", "mod.pyc"),
      "new-cache\n",
    );
    fs.writeFileSync(
      summary,
      [
        "# Primary implementor summary",
        "",
        "## Files changed",
        "- `README.md` — update docs.",
        "- `src/feature.ts` — add feature code.",
        "",
        "## Commit",
        "- Conventional commit message: `feat: add recovered feature`",
      ].join("\n"),
    );

    const recovery = recoverMutableAgentCommit({
      cwd: tmpDir!,
      before,
      outputFilePath: summary,
      label: "primary implementor",
    });

    expect(recovery.recovered).toBe(true);
    expect(git(["rev-list", "--count", `${before.head}..HEAD`], tmpDir!)).toBe(
      "1",
    );
    expect(git(["log", "-1", "--pretty=%s"], tmpDir!)).toBe(
      "feat: add recovered feature",
    );
    const committedFiles = git(
      ["show", "--name-only", "--pretty=", "HEAD"],
      tmpDir!,
    ).split("\n");
    expect(committedFiles).toContain("README.md");
    expect(committedFiles).toContain("src/feature.ts");
    expect(committedFiles).not.toContain("pkg/__pycache__/mod.pyc");

    const verdict = validatePostAgentHygiene({
      cwd: tmpDir!,
      before,
      outputFilePath: summary,
      requireNonEmptyOutput: true,
      requireNewCommit: true,
      label: "primary implementor",
    });
    expect(verdict).toEqual({ ok: true, errors: [] });
  });

  it("recovers uncommitted files listed as markdown links in agent summaries", () => {
    const before = captureGitSnapshot(tmpDir!);
    const summary = path.join(tmpDir!, ".llm-tmp", "summary.md");
    fs.mkdirSync(path.dirname(summary), { recursive: true });
    fs.mkdirSync(path.join(tmpDir!, "sequencer", "rpc"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir!, "sequencer", "rpc", "rpc_test.go"),
      "package rpc\n",
    );
    git(["add", "sequencer/rpc/rpc_test.go"], tmpDir!);
    git(["commit", "-m", "test fixture"], tmpDir!);
    const beforeImpl = captureGitSnapshot(tmpDir!);
    fs.writeFileSync(
      path.join(tmpDir!, "sequencer", "rpc", "server.go"),
      "package rpc\n",
    );
    fs.writeFileSync(
      summary,
      [
        "# Phase 1.2 primary-impl output",
        "",
        "## Files changed",
        `- [sequencer/rpc/server.go](${path.join(tmpDir!, "sequencer", "rpc", "server.go")}): add RPC server.`,
        "",
        "## Tests run",
        "- `sequencer/rpc/rpc_test.go`: not run.",
        "",
        "## Commit SHA",
        "- Conventional commit message: `feat(sequencer/rpc): add json-rpc ingress handlers`",
      ].join("\n"),
    );

    const recovery = recoverMutableAgentCommit({
      cwd: tmpDir!,
      before: beforeImpl,
      outputFilePath: summary,
      label: "primary implementor",
    });

    expect(before.head).not.toBe(beforeImpl.head);
    expect(recovery.recovered).toBe(true);
    expect(git(["log", "-1", "--pretty=%s"], tmpDir!)).toBe(
      "feat(sequencer/rpc): add json-rpc ingress handlers",
    );
    const committedFiles = git(
      ["show", "--name-only", "--pretty=", "HEAD"],
      tmpDir!,
    ).split("\n");
    expect(committedFiles).toContain("sequencer/rpc/server.go");
    expect(committedFiles).not.toContain("sequencer/rpc/rpc_test.go");
  });

  it("fails closed when recovery sees submodule-internal summary paths without explicit allowlist", () => {
    const subRepo = fs.mkdtempSync(
      path.join(os.tmpdir(), "gstack-submodule-src-"),
    );
    git(["init", "--initial-branch=main"], subRepo);
    git(["config", "user.email", "test@test.com"], subRepo);
    git(["config", "user.name", "Test User"], subRepo);
    fs.writeFileSync(path.join(subRepo, "lib.go"), "package lib\n");
    git(["add", "lib.go"], subRepo);
    git(["commit", "-m", "submodule init"], subRepo);

    git(
      [
        "-c",
        "protocol.file.allow=always",
        "submodule",
        "add",
        subRepo,
        "vendor/lib",
      ],
      tmpDir!,
    );
    git(["commit", "-am", "add submodule"], tmpDir!);
    const before = captureGitSnapshot(tmpDir!);
    const subPath = path.join(tmpDir!, "vendor", "lib");
    git(["config", "user.email", "test@test.com"], subPath);
    git(["config", "user.name", "Test User"], subPath);
    fs.writeFileSync(
      path.join(subPath, "lib.go"),
      "package lib\nconst X = 1\n",
    );
    git(["add", "lib.go"], subPath);
    git(["commit", "-m", "change submodule"], subPath);

    const summary = path.join(tmpDir!, ".llm-tmp", "summary.md");
    fs.mkdirSync(path.dirname(summary), { recursive: true });
    fs.writeFileSync(
      summary,
      [
        "# Summary",
        "- `vendor/lib/lib.go` — changed submodule code.",
        "- Conventional commit message: `feat: recover submodule pointer`",
      ].join("\n"),
    );

    const recovery = recoverMutableAgentCommit({
      cwd: tmpDir!,
      before,
      outputFilePath: summary,
      label: "primary implementor",
    });

    expect(recovery.recovered).toBe(false);
    expect(recovery.errors.join("\n")).toContain(
      "Refusing to stage submodule vendor/lib",
    );
    expect(git(["rev-parse", "HEAD"], tmpDir!)).toBe(before.head);
  });

  it("stages only an explicitly allowed clean submodule gitlink during recovery", () => {
    const subRepo = fs.mkdtempSync(
      path.join(os.tmpdir(), "gstack-submodule-src-"),
    );
    git(["init", "--initial-branch=main"], subRepo);
    git(["config", "user.email", "test@test.com"], subRepo);
    git(["config", "user.name", "Test User"], subRepo);
    fs.writeFileSync(path.join(subRepo, "lib.go"), "package lib\n");
    git(["add", "lib.go"], subRepo);
    git(["commit", "-m", "submodule init"], subRepo);

    git(
      [
        "-c",
        "protocol.file.allow=always",
        "submodule",
        "add",
        subRepo,
        "vendor/lib",
      ],
      tmpDir!,
    );
    git(["commit", "-am", "add submodule"], tmpDir!);
    const before = captureGitSnapshot(tmpDir!);
    const subPath = path.join(tmpDir!, "vendor", "lib");
    git(["config", "user.email", "test@test.com"], subPath);
    git(["config", "user.name", "Test User"], subPath);
    fs.writeFileSync(
      path.join(subPath, "lib.go"),
      "package lib\nconst X = 1\n",
    );
    git(["add", "lib.go"], subPath);
    git(["commit", "-m", "change submodule"], subPath);

    const summary = path.join(tmpDir!, ".llm-tmp", "summary.md");
    fs.mkdirSync(path.dirname(summary), { recursive: true });
    fs.writeFileSync(
      summary,
      [
        "# Summary",
        "- `vendor/lib/lib.go` — changed submodule code.",
        "- Conventional commit message: `feat: recover submodule pointer`",
      ].join("\n"),
    );

    const recovery = recoverMutableAgentCommit({
      cwd: tmpDir!,
      before,
      outputFilePath: summary,
      label: "primary implementor",
      allowSubmoduleRecovery: ["vendor/lib"],
    });

    expect(recovery.recovered).toBe(true);
    expect(git(["log", "-1", "--pretty=%s"], tmpDir!)).toBe(
      "feat: recover submodule pointer",
    );
    const committedFiles = git(
      ["show", "--name-only", "--pretty=", "HEAD"],
      tmpDir!,
    ).split("\n");
    expect(committedFiles).toEqual(["vendor/lib"]);
  });

  it("accepts a committed clean implementor run with a non-empty summary", () => {
    const before = captureGitSnapshot(tmpDir!);
    const summary = path.join(tmpDir!, ".llm-tmp", "summary.md");
    fs.mkdirSync(path.dirname(summary), { recursive: true });
    fs.writeFileSync(summary, "changed README and committed\n");
    fs.writeFileSync(path.join(tmpDir!, "README.md"), "changed\n");
    git(["add", "README.md"], tmpDir!);
    git(["commit", "-m", "change readme"], tmpDir!);

    const verdict = validatePostAgentHygiene({
      cwd: tmpDir!,
      before,
      outputFilePath: summary,
      requireNonEmptyOutput: true,
      requireNewCommit: true,
      label: "primary implementor",
    });

    expect(verdict).toEqual({ ok: true, errors: [] });
  });

  it("writes hygiene failures to a dedicated sibling log", () => {
    const originalLog = path.join(
      tmpDir!,
      ".llm-tmp",
      "phase-1-primary-impl-1.log",
    );
    fs.mkdirSync(path.dirname(originalLog), { recursive: true });
    fs.writeFileSync(originalLog, "original agent output\n");

    const result = hygieneFailureResult(
      "primary implementor did not create a new commit",
      originalLog,
    );
    const expectedLog = path.join(
      tmpDir!,
      ".llm-tmp",
      "phase-1-primary-impl-1-hygiene.log",
    );

    expect(result.exitCode).toBe(1);
    expect(result.logPath).toBe(expectedLog);
    expect(result.stdout).toContain("# Post-agent hygiene failure");
    expect(result.stdout).toContain(
      "primary implementor did not create a new commit",
    );
    expect(result.stdout).toContain(`Original agent log: ${originalLog}`);
    expect(fs.readFileSync(expectedLog, "utf8")).toBe(result.stdout);
  });

  it("detects parent workspace root HEAD and status changes", () => {
    const workspace = path.join(tmpDir!, "parent-workspace");
    const child = path.join(workspace, "app");
    fs.mkdirSync(child, { recursive: true });
    git(["init", "--initial-branch=main"], workspace);
    git(["config", "user.email", "test@test.com"], workspace);
    git(["config", "user.name", "Test User"], workspace);
    fs.writeFileSync(path.join(workspace, "README.md"), "root\n");
    git(["add", "README.md"], workspace);
    git(["commit", "-m", "root init"], workspace);
    git(["init", "--initial-branch=main"], child);

    const before = captureGitSnapshot(workspace);
    fs.writeFileSync(path.join(workspace, "README.md"), "root changed\n");
    git(["add", "README.md"], workspace);
    git(["commit", "-m", "root change"], workspace);
    fs.writeFileSync(path.join(workspace, "root-scratch.txt"), "dirty\n");

    const verdict = validateParentWorkspaceUnchanged({
      before,
      workspaceRoot: workspace,
      label: "primary implementor",
    });

    expect(verdict.ok).toBe(false);
    expect(verdict.errors.join("\n")).toContain("changed workspace root HEAD");
    expect(verdict.errors.join("\n")).toContain(
      "changed workspace root status",
    );
  });
});

describe("plan storage helpers", () => {
  it("uses explicit --project-root when plan lives outside the product repo", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gstack-root-"));
    const project = path.join(tmpDir, "app");
    const mirror = path.join(tmpDir, "app-gstack", "inbox", "living-plan");
    fs.mkdirSync(project, { recursive: true });
    fs.mkdirSync(mirror, { recursive: true });
    const plan = path.join(mirror, "app-impl-plan-20260430.md");
    fs.writeFileSync(plan, "# plan\n");

    expect(resolveProjectRoot({ planFile: plan, projectRoot: project })).toBe(
      project,
    );
  });

  it("rejects a workspace root with child repos unless explicitly allowed", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gstack-workspace-"));
    const child = path.join(tmpDir, "app");
    fs.mkdirSync(child, { recursive: true });
    spawnSync("git", ["init"], { cwd: tmpDir, stdio: "ignore" });
    spawnSync("git", ["init"], { cwd: child, stdio: "ignore" });

    expect(() => validateProjectRootSelection(tmpDir, false)).toThrow(
      /workspace root/i,
    );
    expect(validateProjectRootSelection(tmpDir, true)).toBe(tmpDir);
  });

  it("requires --project-root when invoked from an ambiguous *-gstack repo", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gstack-root-"));
    const mirror = path.join(tmpDir, "app-gstack");
    const living = path.join(mirror, "living-plans");
    fs.mkdirSync(living, { recursive: true });
    spawnSync("git", ["init"], { cwd: mirror, stdio: "ignore" });
    const plan = path.join(living, "app-impl-plan-20260430.md");
    fs.writeFileSync(plan, "# plan\n");

    expect(() => resolveProjectRoot({ planFile: plan, cwd: mirror })).toThrow(
      /--project-root/,
    );
  });

  it("does not bind a sibling living plan to the current product repo implicitly", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gstack-root-"));
    const currentProject = path.join(tmpDir, "app-b");
    const mirror = path.join(tmpDir, "app-a-gstack");
    const living = path.join(mirror, "living-plans");
    fs.mkdirSync(currentProject, { recursive: true });
    fs.mkdirSync(living, { recursive: true });
    spawnSync("git", ["init"], { cwd: currentProject, stdio: "ignore" });
    spawnSync("git", ["init"], { cwd: mirror, stdio: "ignore" });
    const plan = path.join(living, "app-a-impl-plan-20260430.md");
    fs.writeFileSync(plan, "# plan\n");

    expect(() =>
      resolveProjectRoot({ planFile: plan, cwd: currentProject }),
    ).toThrow(/--project-root/);
  });

  it("requires --project-root for living plans in an uninitialized *-gstack directory too", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gstack-root-"));
    const currentProject = path.join(tmpDir, "app-b");
    const living = path.join(tmpDir, "app-a-gstack", "living-plans");
    fs.mkdirSync(currentProject, { recursive: true });
    fs.mkdirSync(living, { recursive: true });
    spawnSync("git", ["init"], { cwd: currentProject, stdio: "ignore" });
    const plan = path.join(living, "app-a-impl-plan-20260430.md");
    fs.writeFileSync(plan, "# plan\n");

    expect(() =>
      resolveProjectRoot({ planFile: plan, cwd: currentProject }),
    ).toThrow(/--project-root/);
  });

  it("requires --project-root for inbox plans in a sibling *-gstack repo", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gstack-root-"));
    const currentProject = path.join(tmpDir, "app-b");
    const inbox = path.join(tmpDir, "app-a-gstack", "inbox");
    fs.mkdirSync(currentProject, { recursive: true });
    fs.mkdirSync(inbox, { recursive: true });
    spawnSync("git", ["init"], { cwd: currentProject, stdio: "ignore" });
    const plan = path.join(inbox, "app-a-plan-20260430.md");
    fs.writeFileSync(plan, "# plan\n");

    expect(() =>
      resolveProjectRoot({ planFile: plan, cwd: currentProject }),
    ).toThrow(/--project-root/);
  });

  it("requires --project-root for inbox living plans in a sibling *-gstack repo", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gstack-root-"));
    const currentProject = path.join(tmpDir, "app-b");
    const living = path.join(tmpDir, "app-a-gstack", "inbox", "living-plan");
    fs.mkdirSync(currentProject, { recursive: true });
    fs.mkdirSync(living, { recursive: true });
    spawnSync("git", ["init"], { cwd: currentProject, stdio: "ignore" });
    const plan = path.join(living, "app-a-impl-plan-20260430.md");
    fs.writeFileSync(plan, "# plan\n");

    expect(() =>
      resolveProjectRoot({ planFile: plan, cwd: currentProject }),
    ).toThrow(/--project-root/);
  });

  it("prefers the plan repo over the current cwd repo for in-repo plans", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gstack-root-"));
    const planProject = path.join(tmpDir, "app-a");
    const currentProject = path.join(tmpDir, "app-b");
    const plans = path.join(planProject, "plans");
    fs.mkdirSync(plans, { recursive: true });
    fs.mkdirSync(currentProject, { recursive: true });
    spawnSync("git", ["init"], { cwd: planProject, stdio: "ignore" });
    spawnSync("git", ["init"], { cwd: currentProject, stdio: "ignore" });
    const plan = path.join(plans, "app-a-impl-plan-20260430.md");
    fs.writeFileSync(plan, "# plan\n");

    expect(resolveProjectRoot({ planFile: plan, cwd: currentProject })).toBe(
      planProject,
    );
  });

  it("archives completed living plans into the sibling archived dir", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gstack-archive-"));
    const living = path.join(tmpDir, "app-gstack", "living-plans");
    fs.mkdirSync(living, { recursive: true });
    const plan = path.join(living, "app-impl-plan-20260430.md");
    fs.writeFileSync(plan, "# plan\n");

    const archived = archiveLivingPlan(plan);
    expect(archived).toBe(
      path.join(tmpDir, "app-gstack", "archived", "app-impl-plan-20260430.md"),
    );
    expect(fs.existsSync(plan)).toBe(false);
    expect(fs.existsSync(archived!)).toBe(true);
  });

  it("archives completed inbox living plans into the sibling archived dir", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gstack-archive-"));
    const living = path.join(tmpDir, "app-gstack", "inbox", "living-plan");
    fs.mkdirSync(living, { recursive: true });
    const plan = path.join(living, "app-impl-plan-20260430.md");
    fs.writeFileSync(plan, "# plan\n");

    const archived = archiveLivingPlan(plan);
    expect(archived).toBe(
      path.join(tmpDir, "app-gstack", "archived", "app-impl-plan-20260430.md"),
    );
    expect(fs.existsSync(plan)).toBe(false);
    expect(fs.existsSync(archived!)).toBe(true);
  });

  it("archives completed origin plans from the sibling inbox into archived", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gstack-origin-archive-"));
    const inbox = path.join(tmpDir, "app-gstack", "inbox");
    fs.mkdirSync(inbox, { recursive: true });
    const plan = path.join(inbox, "app-plan-20260430.md");
    fs.writeFileSync(plan, "# source plan\n");

    const archived = archiveOriginPlan(plan);
    expect(archived).toBe(
      path.join(tmpDir, "app-gstack", "archived", "app-plan-20260430.md"),
    );
    expect(fs.existsSync(plan)).toBe(false);
    expect(fs.existsSync(archived!)).toBe(true);
  });

  it("does not archive origin plans outside a gstack inbox/plans dir", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gstack-origin-archive-"));
    const dir = path.join(tmpDir, "app", "plans");
    fs.mkdirSync(dir, { recursive: true });
    const plan = path.join(dir, "app-plan-20260430.md");
    fs.writeFileSync(plan, "# source plan\n");

    expect(archiveOriginPlan(plan)).toBeNull();
    expect(fs.existsSync(plan)).toBe(true);
  });
});

describe("remote base detection", () => {
  function git(args: string[], cwd: string) {
    const r = spawnSync("git", args, { cwd, encoding: "utf8" });
    if (r.status !== 0) {
      throw new Error(`git ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
    }
    return r.stdout.trim();
  }

  function setupOriginHeadRepo() {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gstack-origin-head-"));
    const repo = path.join(tmpDir, "repo");
    const bare = path.join(tmpDir, "origin.git");
    fs.mkdirSync(repo, { recursive: true });
    fs.mkdirSync(bare, { recursive: true });
    git(["init", "--bare", "--initial-branch=develop"], bare);
    git(["symbolic-ref", "HEAD", "refs/heads/develop"], bare);
    git(["init", "--initial-branch=main"], repo);
    git(["config", "user.email", "test@test.com"], repo);
    git(["config", "user.name", "Test User"], repo);
    git(["remote", "add", "origin", bare], repo);
    fs.writeFileSync(path.join(repo, "README.md"), "main\n");
    git(["add", "."], repo);
    git(["commit", "-m", "main init"], repo);
    git(["push", "-u", "origin", "main"], repo);
    git(["checkout", "-b", "develop"], repo);
    fs.writeFileSync(path.join(repo, "default.txt"), "develop default\n");
    git(["add", "."], repo);
    git(["commit", "-m", "develop default"], repo);
    git(["push", "-u", "origin", "develop"], repo);
    git(["fetch", "origin"], repo);
    git(["remote", "set-head", "origin", "-a"], repo);
    return repo;
  }

  it("resolves origin/HEAD before main or master", () => {
    const repo = setupOriginHeadRepo();
    expect(detectRemoteBaseRef(repo)).toBe("origin/develop");
  });

  it("syncFeatureBranchWithBase merges the origin/HEAD default branch", () => {
    const repo = setupOriginHeadRepo();
    git(["checkout", "main"], repo);
    git(["checkout", "-b", "feat/work"], repo);
    fs.writeFileSync(path.join(repo, "feature.txt"), "feature\n");
    git(["add", "."], repo);
    git(["commit", "-m", "feature work"], repo);

    const result = syncFeatureBranchWithBase(repo, "feat/work");

    expect(result.ok).toBe(true);
    expect(result.baseRef).toBe("origin/develop");
    expect(fs.readFileSync(path.join(repo, "default.txt"), "utf8")).toBe(
      "develop default\n",
    );
  });

  it("syncLandedBase fetches origin and returns the base branch name without checking it out", () => {
    const repo = setupOriginHeadRepo();
    git(["checkout", "main"], repo);

    const result = syncLandedBase(repo);

    expect(result).toEqual({ ok: true, branch: "develop" });
    // Must NOT have switched branches — worktree-safe behaviour.
    expect(git(["branch", "--show-current"], repo)).toBe("main");
    // The tracking ref must be up-to-date after the fetch.
    const refExists = spawnSync(
      "git",
      ["rev-parse", "--verify", "origin/develop"],
      {
        cwd: repo,
        encoding: "utf8",
      },
    );
    expect(refExists.status).toBe(0);
  });

  it("syncLandedBase succeeds in a linked worktree where base is checked out in the primary clone", () => {
    const repo = setupOriginHeadRepo();
    // Simulate a linked worktree: the primary clone has `develop` checked out,
    // but we run syncLandedBase inside it. Previously this would have tried
    // `git checkout develop` which fails in the primary clone itself if some
    // worktree already has it, or is a no-op if we're already on it. The new
    // behaviour just fetches and reads the tracking ref — no checkout needed.
    git(["checkout", "develop"], repo);

    const result = syncLandedBase(repo);

    expect(result.ok).toBe(true);
    expect(result.branch).toBe("develop");
    // Still on develop, not moved anywhere.
    expect(git(["branch", "--show-current"], repo)).toBe("develop");
  });

  it("syncLandedBase returns ok:false when fetch fails (no remote configured)", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gstack-sync-noremote-"));
    const repo = path.join(tmpDir, "repo");
    fs.mkdirSync(repo);
    spawnSync("git", ["init", "-b", "main"], { cwd: repo });
    spawnSync("git", ["config", "user.email", "test@test.com"], { cwd: repo });
    spawnSync("git", ["config", "user.name", "Test"], { cwd: repo });
    fs.writeFileSync(path.join(repo, "f"), "x");
    spawnSync("git", ["add", "."], { cwd: repo });
    spawnSync("git", ["commit", "-m", "init"], { cwd: repo });
    // No remote configured — fetch must fail.
    const result = syncLandedBase(repo);
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });
});

describe("buildOriginVerificationBody", () => {
  it("asks for a GATE PASS / GATE FAIL origin-plan check", () => {
    const body = buildOriginVerificationBody({
      feature: {
        index: 0,
        number: "1",
        name: "Auth",
        phaseIndexes: [0, 1],
        status: "origin_verifying",
      },
      livingPlanFile: "living.md",
      originPlanFile: "origin.md",
    });
    expect(body).toContain("Origin plan: origin.md");
    expect(body).toContain("GATE PASS");
    expect(body).toContain("GATE FAIL");
  });
});

describe("buildDualImplPromptBody (dual-impl implementation prompt)", () => {
  it('contains "implement"', () => {
    const body = buildDualImplPromptBody({
      phase: basePhase,
      planFile: "plan.md",
      candidate: "primary",
      opponent: "secondary",
    });
    expect(body.toLowerCase()).toMatch(/implement/);
  });

  it('contains "do NOT change test assertions"', () => {
    const body = buildDualImplPromptBody({
      phase: basePhase,
      planFile: "plan.md",
      candidate: "primary",
      opponent: "secondary",
    });
    expect(body).toMatch(/do NOT change test assertions/i);
  });

  it("contains the phase name, plan file, and candidate labels", () => {
    const body = buildDualImplPromptBody({
      phase: basePhase,
      planFile: "plan.md",
      candidate: "primary",
      opponent: "secondary",
    });
    expect(body).toContain(basePhase.name);
    expect(body).toContain("plan.md");
    expect(body).toContain("primary implementor");
    expect(body).toContain("secondary implementor");
  });
});

describe("buildCodexReviewBody (configured review gate context)", () => {
  it("does not hardcode /gstack-review so configured commands stay authoritative", () => {
    const body = buildCodexReviewBody(
      basePhase,
      "plan.md",
      "feat/test",
      1,
      null,
    );
    expect(body).toContain("slash command specified by the runner prompt");
    expect(body).not.toContain("/gstack-review");
  });

  it("includes origin-plan issue reports when restarting a feature loop", () => {
    const body = buildCodexReviewBody(
      basePhase,
      "plan.md",
      "feat/test",
      1,
      null,
      undefined,
      "/tmp/origin-issues.md",
    );
    expect(body).toContain("Origin-plan verification issues");
    expect(body).toContain("/tmp/origin-issues.md");
    expect(body).toContain("Fix every concrete gap");
  });
});

describe("restartFeatureFromOriginIssues", () => {
  function stateAndFeature(): { state: BuildState; feature: FeatureState } {
    const feature: FeatureState = {
      index: 0,
      number: "1",
      name: "Auth",
      phaseIndexes: [0, 1],
      status: "origin_verifying",
      featureReview: {
        iterations: 1,
        outputLogPaths: ["/tmp/feature-review.log"],
        outputFilePaths: ["/tmp/feature-review.md"],
        finalVerdict: "FEATURE_PASS",
      },
    };
    return {
      feature,
      state: {
        planFile: "plan.md",
        planBasename: "plan",
        slug: "plan",
        branch: "feat/auth",
        startedAt: "2026-04-30T00:00:00.000Z",
        lastUpdatedAt: "2026-04-30T00:00:00.000Z",
        currentPhaseIndex: 0,
        currentFeatureIndex: 0,
        features: [feature],
        phases: [
          { index: 0, number: "1.1", name: "Tests", status: "committed" },
          {
            index: 1,
            number: "1.2",
            name: "Implementation",
            status: "committed",
            codexReview: {
              iterations: 2,
              finalVerdict: "GATE PASS",
              outputLogPaths: ["/tmp/review.md"],
            },
          },
        ],
        completed: false,
        geminiModel: "gemini",
        codexModel: "codex",
        codexReviewModel: "codex-review",
      },
    };
  }

  it("records origin issues and resets the feature to its review loop", () => {
    const { state, feature } = stateAndFeature();
    const restart = restartFeatureFromOriginIssues({
      state,
      feature,
      issueLogPath: "/tmp/origin-issues.md",
      reason: "missing acceptance behavior",
    });
    expect(restart).toEqual({ restarted: true, phaseIndex: 1 });
    expect(feature.status).toBe("running");
    expect(feature.originVerificationAttempts).toBe(1);
    expect(feature.originIssueLogPaths).toEqual(["/tmp/origin-issues.md"]);
    expect(feature.featureReview).toBeUndefined();
    expect(state.phases[1].status).toBe("tests_green");
    expect(state.phases[1].codexReview).toBeUndefined();
    expect(state.phases[1].originIssueLogPath).toBe("/tmp/origin-issues.md");
  });

  it("pauses after the origin verification retry cap is exhausted", () => {
    const { state, feature } = stateAndFeature();
    feature.originVerificationAttempts = 1;
    const restart = restartFeatureFromOriginIssues({
      state,
      feature,
      issueLogPath: "/tmp/origin-issues.md",
      reason: "still missing behavior",
      maxAttempts: 1,
    });
    expect(restart.restarted).toBe(false);
    expect(feature.status).toBe("paused");
    expect(feature.error).toContain("still failing after 1 auto-fix attempts");
  });
});

describe("markPhaseCommittedAfterManualRecovery", () => {
  it("marks a failed phase committed without deleting test artifacts or rerunning the phase", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gstack-manual-recovery-"));
    const planFile = path.join(tmpDir, "plan.md");
    fs.writeFileSync(
      planFile,
      [
        "# Plan",
        "",
        "## Feature 1: Auth",
        "",
        "### Phase 1.1: Middleware",
        "- [ ] **Test Specification (Gemini Sub-agent)**: Write failing tests.",
        "- [ ] **Implementation (Codex Sub-agent)**: Implement.",
        "- [ ] **Review (Codex Sub-agent)**: Review.",
        "",
      ].join("\n"),
    );
    const phase: Phase = {
      ...basePhase,
      number: "1.1",
      name: "Middleware",
      testSpecCheckboxLine: 6,
      implementationCheckboxLine: 7,
      reviewCheckboxLine: 8,
    };
    const feature: FeatureState = {
      index: 0,
      number: "1",
      name: "Auth",
      phaseIndexes: [0],
      status: "paused",
      error: "old phase failure",
    };
    const state: BuildState = {
      planFile,
      planBasename: "plan",
      slug: "build-plan",
      branch: "feat/auth",
      startedAt: "2026-05-08T00:00:00.000Z",
      lastUpdatedAt: "2026-05-08T00:00:00.000Z",
      currentPhaseIndex: 0,
      currentFeatureIndex: 0,
      features: [feature],
      phases: [
        {
          index: 0,
          number: "1.1",
          name: "Middleware",
          status: "failed",
          error: "old hygiene failure",
          geminiTestSpec: {
            startedAt: "2026-05-08T00:00:00.000Z",
            outputLogPath: "/tmp/testspec.log",
            outputFilePath: "/tmp/testspec.md",
            retries: 0,
          },
        },
      ],
      failedAtPhase: 0,
      failureReason: "old hygiene failure",
      completed: false,
    };

    const result = markPhaseCommittedAfterManualRecovery({
      state,
      phases: [phase],
      phaseNumber: "1.1",
      planFile,
    });

    expect(result).toEqual({ ok: true, phaseIndex: 0 });
    expect(state.phases[0].status).toBe("committed");
    expect(state.phases[0].error).toBeUndefined();
    expect(state.phases[0].geminiTestSpec).toBeDefined();
    expect(state.failedAtPhase).toBeUndefined();
    expect(state.failureReason).toBeUndefined();
    expect(feature.status).toBe("running");
    expect(feature.error).toBeUndefined();
    const updatedPlan = fs.readFileSync(planFile, "utf8");
    expect(updatedPlan).toContain("- [x] **Test Specification");
    expect(updatedPlan).toContain("- [x] **Implementation");
    expect(updatedPlan).toContain("- [x] **Review");
  });

  it("does not clear an unrelated recorded failure when marking a different phase", () => {
    tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "gstack-manual-recovery-other-"),
    );
    const planFile = path.join(tmpDir, "plan.md");
    fs.writeFileSync(
      planFile,
      [
        "# Plan",
        "",
        "### Phase 1.1: First",
        "- [ ] **Implementation (Codex Sub-agent)**: Implement.",
        "- [ ] **Review (Codex Sub-agent)**: Review.",
        "",
        "### Phase 1.2: Second",
        "- [ ] **Implementation (Codex Sub-agent)**: Implement.",
        "- [ ] **Review (Codex Sub-agent)**: Review.",
        "",
      ].join("\n"),
    );
    const phases: Phase[] = [
      {
        ...basePhase,
        index: 0,
        number: "1.1",
        name: "First",
        testSpecCheckboxLine: -1,
        implementationCheckboxLine: 4,
        reviewCheckboxLine: 5,
      },
      {
        ...basePhase,
        index: 1,
        number: "1.2",
        name: "Second",
        testSpecCheckboxLine: -1,
        implementationCheckboxLine: 8,
        reviewCheckboxLine: 9,
      },
    ];
    const state: BuildState = {
      planFile,
      planBasename: "plan",
      slug: "build-plan",
      branch: "feat/auth",
      startedAt: "2026-05-08T00:00:00.000Z",
      lastUpdatedAt: "2026-05-08T00:00:00.000Z",
      currentPhaseIndex: 0,
      currentFeatureIndex: 0,
      features: [
        {
          index: 0,
          number: "1",
          name: "Full plan",
          phaseIndexes: [0, 1],
          status: "paused",
          error: "phase 1.2 failed",
        },
      ],
      phases: [
        { index: 0, number: "1.1", name: "First", status: "review_clean" },
        { index: 1, number: "1.2", name: "Second", status: "failed" },
      ],
      failedAtPhase: 1,
      failureReason: "phase 1.2 failed",
      completed: false,
    };

    const result = markPhaseCommittedAfterManualRecovery({
      state,
      phases,
      phaseNumber: "1.1",
      planFile,
    });

    expect(result).toEqual({ ok: true, phaseIndex: 0 });
    expect(state.failedAtPhase).toBe(1);
    expect(state.failureReason).toBe("phase 1.2 failed");
    expect(state.features[0].status).toBe("paused");
    expect(state.features[0].error).toBe("phase 1.2 failed");
  });

  it("fails closed when the parsed plan phase no longer matches persisted state at that index", () => {
    tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "gstack-manual-recovery-mismatch-"),
    );
    const planFile = path.join(tmpDir, "plan.md");
    fs.writeFileSync(
      planFile,
      [
        "# Plan",
        "",
        "### Phase 1.1: First",
        "- [ ] **Implementation (Codex Sub-agent)**: Implement.",
        "- [ ] **Review (Codex Sub-agent)**: Review.",
        "",
      ].join("\n"),
    );
    const phase: Phase = {
      ...basePhase,
      index: 0,
      number: "1.1",
      name: "First",
      testSpecCheckboxLine: -1,
      implementationCheckboxLine: 4,
      reviewCheckboxLine: 5,
    };
    const state: BuildState = {
      planFile,
      planBasename: "plan",
      slug: "build-plan",
      branch: "feat/auth",
      startedAt: "2026-05-08T00:00:00.000Z",
      lastUpdatedAt: "2026-05-08T00:00:00.000Z",
      currentPhaseIndex: 0,
      currentFeatureIndex: 0,
      features: [
        {
          index: 0,
          number: "1",
          name: "Full plan",
          phaseIndexes: [0],
          status: "paused",
        },
      ],
      phases: [
        { index: 0, number: "9.9", name: "Stale phase", status: "failed" },
      ],
      failedAtPhase: 0,
      failureReason: "old failure",
      completed: false,
    };

    const result = markPhaseCommittedAfterManualRecovery({
      state,
      phases: [phase],
      phaseNumber: "1.1",
      planFile,
    });

    expect(result).toEqual({
      ok: false,
      error:
        "state/plan phase mismatch at index 0: plan has 1.1, state has 9.9",
    });
    expect(state.phases[0].status).toBe("failed");
    const unchangedPlan = fs.readFileSync(planFile, "utf8");
    expect(unchangedPlan).toContain("- [ ] **Implementation");
    expect(unchangedPlan).toContain("- [ ] **Review");
  });
});

describe("ensureFeatureBranch", () => {
  function stateForBranchTest(
    slug: string,
    feature: FeatureState,
    branch = "feat/other",
  ): BuildState {
    return {
      planFile: "plan.md",
      planBasename: "plan",
      slug,
      branch,
      startedAt: "2026-04-30T00:00:00.000Z",
      lastUpdatedAt: "2026-04-30T00:00:00.000Z",
      currentPhaseIndex: 0,
      currentFeatureIndex: 0,
      features: [feature],
      phases: [],
      completed: false,
      geminiModel: "gemini",
      codexModel: "codex",
      codexReviewModel: "codex-review",
    };
  }

  it("checks out a saved feature branch when resuming from another branch", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gstack-feature-branch-"));
    const repo = tmpDir;
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
    expect(
      spawnSync("git", ["checkout", "-b", "feat/auth"], { cwd: repo }).status,
    ).toBe(0);
    expect(spawnSync("git", ["checkout", "main"], { cwd: repo }).status).toBe(
      0,
    );
    expect(
      spawnSync("git", ["checkout", "-b", "feat/other"], { cwd: repo }).status,
    ).toBe(0);

    const slug = `test-branch-${Date.now()}`;
    const feature: FeatureState = {
      index: 0,
      number: "1",
      name: "Auth",
      phaseIndexes: [],
      status: "running",
      branch: "feat/auth",
    };
    const state = stateForBranchTest(slug, feature);

    expect(
      ensureFeatureBranch({
        cwd: repo,
        state,
        feature,
        dryRun: false,
        noGbrain: true,
      }),
    ).toBe(true);
    const current = spawnSync("git", ["branch", "--show-current"], {
      cwd: repo,
      encoding: "utf8",
    }).stdout.trim();
    expect(current).toBe("feat/auth");
    fs.rmSync(statePath(slug), { force: true });
  });

  it("creates a follow-up branch from base for landed origin-verification retries", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gstack-origin-retry-"));
    const bare = path.join(tmpDir, "origin.git");
    const repo = path.join(tmpDir, "repo");
    expect(spawnSync("git", ["init", "--bare", bare]).status).toBe(0);
    expect(spawnSync("git", ["clone", bare, repo]).status).toBe(0);
    expect(
      spawnSync("git", ["checkout", "-b", "main"], { cwd: repo }).status,
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
      spawnSync("git", ["push", "-u", "origin", "main"], { cwd: repo }).status,
    ).toBe(0);
    expect(
      spawnSync("git", ["checkout", "-b", "feat/auth"], { cwd: repo }).status,
    ).toBe(0);
    expect(spawnSync("git", ["checkout", "main"], { cwd: repo }).status).toBe(
      0,
    );
    expect(
      spawnSync("git", ["branch", "-D", "feat/auth"], { cwd: repo }).status,
    ).toBe(0);

    const slug = `test-origin-retry-${Date.now()}`;
    const feature: FeatureState = {
      index: 0,
      number: "1",
      name: "Auth",
      phaseIndexes: [],
      status: "running",
      branch: "feat/auth",
      landedAt: "2026-04-30T00:00:00.000Z",
      originVerificationAttempts: 1,
    };
    const state = stateForBranchTest(slug, feature, "main");

    expect(
      ensureFeatureBranch({
        cwd: repo,
        state,
        feature,
        dryRun: false,
        noGbrain: true,
      }),
    ).toBe(true);
    const current = spawnSync("git", ["branch", "--show-current"], {
      cwd: repo,
      encoding: "utf8",
    }).stdout.trim();
    expect(current).toBe("feat/auth-followup-1");
    expect(feature.branch).toBe("feat/auth-followup-1");
    expect(state.branch).toBe("feat/auth-followup-1");
    fs.rmSync(statePath(slug), { force: true });
  });

  it("uses branchPrefix for owned feature branches", () => {
    const slug = `test-prefix-${Date.now()}`;
    const feature: FeatureState = {
      index: 0,
      number: "1",
      name: "Auth",
      phaseIndexes: [],
      status: "running",
    };
    const state = stateForBranchTest(slug, feature);
    state.launch = {
      argv: ["plan.md"],
      projectRoot: "/repo",
      runId: "run-1",
      branchPrefix: "repo-run-1",
      activeRunRegistry: path.join(os.tmpdir(), "active-runs"),
      dryRun: true,
      skipShip: false,
      skipFeatureReview: false,
      launchedAt: "2026-04-30T00:00:00.000Z",
      stateSlug: slug,
    };

    expect(
      ensureFeatureBranch({
        cwd: process.cwd(),
        state,
        feature,
        dryRun: true,
        noGbrain: true,
      }),
    ).toBe(true);
    expect(feature.branch).toBe("feat/repo-run-1-1-auth");
    expect(state.branch).toBe("feat/repo-run-1-1-auth");
    fs.rmSync(statePath(slug), { force: true });
  });

  it("creates new feature branch from origin/<base> without checking out the local base branch", () => {
    // Regression test for worktree-safe branch creation. Previously the code did
    // `git checkout <base>` then `git checkout -b feat/...`, which fails in a
    // linked worktree where <base> is already checked out somewhere else.
    // The fixed path does `git fetch origin <base>` then
    // `git checkout -b feat/... origin/<base>`, requiring no local checkout of base.
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gstack-feature-origin-"));
    const bare = path.join(tmpDir, "origin.git");
    const repo = path.join(tmpDir, "repo");
    spawnSync("git", ["init", "--bare", bare]);
    spawnSync("git", ["clone", bare, repo]);
    spawnSync("git", ["config", "user.email", "test@test.com"], { cwd: repo });
    spawnSync("git", ["config", "user.name", "Test User"], { cwd: repo });
    fs.writeFileSync(path.join(repo, "README.md"), "# test\n");
    spawnSync("git", ["add", "README.md"], { cwd: repo });
    spawnSync("git", ["commit", "-m", "init"], { cwd: repo });
    spawnSync("git", ["push", "-u", "origin", "main"], { cwd: repo });

    // Now switch to a different branch (simulates: primary worktree on a feature branch
    // while the base branch is only reachable via origin tracking ref).
    spawnSync("git", ["checkout", "-b", "feat/other"], { cwd: repo });

    const slug = `test-origin-new-${Date.now()}`;
    const feature: FeatureState = {
      index: 0,
      number: "1",
      name: "Auth",
      phaseIndexes: [],
      status: "running",
    };
    const state = stateForBranchTest(slug, feature, "feat/other");

    const result = ensureFeatureBranch({
      cwd: repo,
      state,
      feature,
      dryRun: false,
      noGbrain: true,
    });

    expect(result).toBe(true);
    // The feature branch was created directly from origin/main — no checkout of main needed.
    const current = spawnSync("git", ["branch", "--show-current"], {
      cwd: repo,
      encoding: "utf8",
    }).stdout.trim();
    // Branch name includes plan basename ("plan") + feature number + slugified name.
    expect(current).toBe("feat/plan-1-auth");
    expect(feature.branch).toBe("feat/plan-1-auth");
    // Confirm the feature branch tracks origin/main (branched from it, not a local checkout).
    const trackingRef = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: repo,
      encoding: "utf8",
    });
    const originMain = spawnSync("git", ["rev-parse", "origin/main"], {
      cwd: repo,
      encoding: "utf8",
    });
    // HEAD should be at same commit as origin/main since we branched from it.
    expect(trackingRef.stdout.trim()).toBe(originMain.stdout.trim());
    fs.rmSync(statePath(slug), { force: true });
  });
});

describe("validateResumeLaunch", () => {
  function launch(projectRoot = "/repo") {
    return {
      argv: ["/plans/plan.md"],
      projectRoot,
      baseProjectRoot: "/base",
      runId: "run-1",
      branchPrefix: "repo-run-1",
      activeRunRegistry: "/registry",
      dryRun: false,
      skipShip: false,
      skipFeatureReview: false,
      launchedAt: "2026-04-30T00:00:00.000Z",
      stateSlug: "build-run-1",
    };
  }

  it("refuses mismatched plan path or project root", () => {
    const state: BuildState = {
      planFile: "/plans/plan.md",
      planBasename: "plan",
      slug: "build-run-1",
      branch: "main",
      startedAt: "2026-04-30T00:00:00.000Z",
      lastUpdatedAt: "2026-04-30T00:00:00.000Z",
      currentPhaseIndex: 0,
      features: [],
      phases: [],
      completed: false,
    };
    state.launch = launch();

    expect(() =>
      validateResumeLaunch(state, launch(), "/plans/other.md"),
    ).toThrow(/wrong-plan\/wrong-repo/);
    expect(() =>
      validateResumeLaunch(state, launch("/other-repo"), "/plans/plan.md"),
    ).toThrow(/projectRoot/);
  });
});

describe("buildJudgePrompt (tournament judge prompt)", () => {
  function pass(): DualImplTestResult {
    return {
      worktreePath: "/tmp/wt",
      testExitCode: 0,
      testLogPath: "/tmp/wt/test.log",
      timedOut: false,
      failureCount: 0,
    };
  }

  function promptWith(
    overrides: Partial<
      Parameters<typeof buildJudgePrompt>[0]["candidates"]
    > = {},
  ) {
    return buildJudgePrompt({
      phase: basePhase,
      candidates: {
        primary: {
          label: "Primary",
          provider: "codex",
          model: "primary-model-under-test",
          diff: "PRIMARY_DIFF_MARKER",
          testResult: pass(),
          ...overrides.primary,
        },
        secondary: {
          label: "Secondary",
          provider: "claude",
          model: "secondary-model-under-test",
          diff: "SECONDARY_DIFF_MARKER",
          testResult: pass(),
          ...overrides.secondary,
        },
      },
    });
  }

  it("contains the WINNER format instructions", () => {
    const prompt = promptWith();
    expect(prompt).toContain("WINNER:");
    expect(prompt).toContain("WINNER: primary");
    expect(prompt).toContain("REASONING:");
  });

  it("contains primary and secondary sections with provider/model metadata and diffs", () => {
    const prompt = promptWith();
    expect(prompt).toMatch(
      /Primary implementor \(codex:primary-model-under-test\)[\s\S]*PRIMARY_DIFF_MARKER/,
    );
    expect(prompt).toMatch(
      /Secondary implementor \(claude:secondary-model-under-test\)[\s\S]*SECONDARY_DIFF_MARKER/,
    );
  });

  it("reflects test exit codes for each implementor", () => {
    const prompt = promptWith({
      primary: { testResult: { ...pass(), testExitCode: 0 } },
      secondary: {
        testResult: { ...pass(), testExitCode: 1, failureCount: 3 },
      },
    });
    expect(prompt).toMatch(/exit/i);
    expect(prompt.toLowerCase()).toMatch(/0/);
    expect(prompt.toLowerCase()).toMatch(/1/);
  });

  it("truncates diffs longer than 40000 chars with a [truncated] marker", () => {
    const hugeDiff = "x".repeat(40001);
    const prompt = promptWith({
      primary: { diff: hugeDiff },
      secondary: { diff: "short" },
    });
    expect(prompt).toContain("[...truncated");
    expect(prompt).toContain("x".repeat(40000));
    expect(prompt).not.toContain("x".repeat(40001));
  });

  it("fmtFixIter: undefined omits fix iteration text from prompt", () => {
    const prompt = promptWith();
    expect(prompt).not.toContain("Fix iterations:");
    expect(prompt).not.toContain("Fix loop:");
  });

  it("fmtFixIter: null emits fix loop not run message", () => {
    const prompt = promptWith({
      primary: { fixIterations: null },
      secondary: { fixIterations: null },
    });
    expect(prompt).toContain("Fix loop: not run");
  });

  it("fmtFixIter: 0 emits passed on first try", () => {
    const prompt = promptWith({
      primary: { fixIterations: 0 },
      secondary: { fixIterations: 0 },
    });
    expect(prompt).toContain("passed on first try");
  });

  it("fmtFixIter: N>0 emits required N fix passes", () => {
    const prompt = promptWith({
      primary: { fixIterations: 3 },
      secondary: { fixIterations: 1 },
    });
    expect(prompt).toContain("required 3 fix passes");
    expect(prompt).toContain("required 1 fix pass");
  });

  it("injects primary fix history section into prompt when provided", () => {
    const history = "--- Fix iteration 1 ---\nTestFailed: expected x got y";
    const prompt = promptWith({
      primary: { fixIterations: 1, fixHistory: history },
    });
    expect(prompt).toContain("Primary fix history");
    expect(prompt).toContain("TestFailed");
  });

  it("injects secondary fix history section into prompt when provided", () => {
    const history = "--- Fix iteration 1 ---\nAssertionError: expected 0 got 1";
    const prompt = promptWith({
      secondary: { fixIterations: 1, fixHistory: history },
    });
    expect(prompt).toContain("Secondary fix history");
    expect(prompt).toContain("AssertionError");
  });

  it("omits fix history section heading when fix history is absent", () => {
    const prompt = promptWith();
    expect(prompt).not.toContain("## Primary fix history");
    expect(prompt).not.toContain("## Secondary fix history");
  });

  it("includes HARDENING format instruction in verdict section", () => {
    const prompt = promptWith();
    expect(prompt).toContain("HARDENING:");
  });
});

describe("phaseGateProjection", () => {
  it("returns empty for pending status", () => {
    expect(phaseGateProjection("pending")).toEqual({});
  });

  it("returns empty for test_spec_running", () => {
    expect(phaseGateProjection("test_spec_running")).toEqual({});
  });

  it("marks test_spec done after test_spec_done", () => {
    const p = phaseGateProjection("test_spec_done");
    expect(p.test_spec).toBe(true);
    expect(p.verify_red).toBeUndefined();
  });

  it("marks test_spec and verify_red done after tests_red", () => {
    const p = phaseGateProjection("tests_red");
    expect(p.test_spec).toBe(true);
    expect(p.verify_red).toBe(true);
    expect(p.implementation).toBeUndefined();
  });

  it("marks impl gates done for gemini_running and dual phases", () => {
    for (const s of [
      "gemini_running",
      "dual_impl_running",
      "dual_impl_done",
      "dual_tests_running",
      "dual_judge_pending",
      "dual_judge_running",
      "dual_winner_pending",
    ] as const) {
      const p = phaseGateProjection(s);
      expect(p.test_spec).toBe(true);
      expect(p.verify_red).toBe(true);
      expect(p.implementation).toBeUndefined();
    }
  });

  it("marks implementation done for impl_done and test_fix_running", () => {
    for (const s of ["impl_done", "test_fix_running"] as const) {
      const p = phaseGateProjection(s);
      expect(p.implementation).toBe(true);
      expect(p.green_tests).toBeUndefined();
    }
  });

  it("marks green_tests done for tests_green", () => {
    const p = phaseGateProjection("tests_green");
    expect(p.green_tests).toBe(true);
    expect(p.review_qa).toBeUndefined();
  });

  it("marks all gates done for committed", () => {
    const p = phaseGateProjection("committed");
    expect(p.test_spec).toBe(true);
    expect(p.verify_red).toBe(true);
    expect(p.implementation).toBe(true);
    expect(p.green_tests).toBe(true);
    expect(p.review_qa).toBe(true);
  });

  it("marks all gates done for codex_running and review_clean", () => {
    for (const s of ["codex_running", "review_clean"] as const) {
      const p = phaseGateProjection(s);
      expect(p.review_qa).toBe(true);
    }
  });

  it("returns empty for failed", () => {
    expect(phaseGateProjection("failed")).toEqual({});
  });
});

describe("reconcileVisiblePlanState", () => {
  function makePhase(overrides: Partial<Phase> = {}): Phase {
    return {
      index: 0,
      number: "1",
      name: "Skeleton",
      featureIndex: 0,
      featureNumber: "1",
      featureName: "Auth",
      implementationDone: false,
      reviewDone: false,
      testSpecDone: false,
      body: "",
      implementationCheckboxLine: 3,
      reviewCheckboxLine: 4,
      testSpecCheckboxLine: 2,
      dualImpl: false,
      ...overrides,
    };
  }

  function makeFeature(overrides: Partial<Feature> = {}): Feature {
    return {
      index: 0,
      number: "1",
      name: "Auth",
      body: "",
      phaseIndexes: [0],
      ...overrides,
    };
  }

  function makeState(
    phaseStatus: PhaseState["status"],
    featureStatus: FeatureState["status"] = "running",
  ): BuildState {
    return {
      planFile: "plan.md",
      planBasename: "plan",
      slug: "test",
      branch: "main",
      startedAt: "2026-01-01T00:00:00.000Z",
      lastUpdatedAt: "2026-01-01T00:00:00.000Z",
      currentPhaseIndex: 0,
      currentFeatureIndex: 0,
      completed: false,
      phases: [
        {
          index: 0,
          number: "1",
          name: "Skeleton",
          status: phaseStatus,
        },
      ],
      features: [
        {
          index: 0,
          number: "1",
          name: "Auth",
          phaseIndexes: [0],
          status: featureStatus,
        },
      ],
    };
  }

  it("flips verify_red and test_spec checkboxes when phase reaches tests_red", () => {
    const plan =
      [
        "## Feature 1: Auth",
        "### Phase 1: Skeleton",
        "- [ ] **Test Specification (Gemini)**",
        "- [ ] **Verify Red (runner)**",
        "- [ ] **Implementation (Gemini)**",
        "- [ ] **Review & QA (Codex)**",
      ].join("\n") + "\n";

    const planFile = _testWritePlan(plan);
    const phase = makePhase({
      testSpecCheckboxLine: 3,
      gates: {
        test_spec: { done: false, line: 3 },
        verify_red: { done: false, line: 4 },
        implementation: { done: false, line: 5 },
        review_qa: { done: false, line: 6 },
      },
    });
    const feature = makeFeature({ gates: {} });
    const state = makeState("tests_red");

    reconcileVisiblePlanState(planFile, [feature], [phase], state, {
      skipShip: false,
      dryRun: false,
    });

    const updated = fs.readFileSync(planFile, "utf8");
    const lines = updated.split("\n");
    expect(lines[2]).toMatch(/\[x\].*Test Specification/);
    expect(lines[3]).toMatch(/\[x\].*Verify Red/);
    expect(lines[4]).toMatch(/\[ \].*Implementation/);
    expect(lines[5]).toMatch(/\[ \].*Review/);
  });

  it("flips all phase gates to [x] for committed status", () => {
    const plan =
      [
        "## Feature 1: Auth",
        "### Phase 1: Skeleton",
        "- [ ] **Test Specification**",
        "- [ ] **Verify Red**",
        "- [ ] **Implementation**",
        "- [ ] **Green Tests**",
        "- [ ] **Review & QA**",
      ].join("\n") + "\n";

    const planFile = _testWritePlan(plan);
    const phase = makePhase({
      gates: {
        test_spec: { done: false, line: 3 },
        verify_red: { done: false, line: 4 },
        implementation: { done: false, line: 5 },
        green_tests: { done: false, line: 6 },
        review_qa: { done: false, line: 7 },
      },
    });
    const feature = makeFeature({ gates: {} });
    const state = makeState("committed");

    reconcileVisiblePlanState(planFile, [feature], [phase], state);

    const updated = fs.readFileSync(planFile, "utf8");
    for (const line of updated.split("\n").slice(2, 7)) {
      expect(line).toMatch(/\[x\]/);
    }
  });

  it("is idempotent — second call makes no additional changes", () => {
    const plan =
      [
        "## Feature 1: Auth",
        "### Phase 1: Skeleton",
        "- [ ] **Test Specification**",
        "- [ ] **Verify Red**",
        "- [ ] **Implementation**",
        "- [ ] **Review & QA**",
      ].join("\n") + "\n";

    const planFile = _testWritePlan(plan);
    const phase = makePhase({
      gates: {
        test_spec: { done: false, line: 3 },
        verify_red: { done: false, line: 4 },
        implementation: { done: false, line: 5 },
        review_qa: { done: false, line: 6 },
      },
    });
    const feature = makeFeature({ gates: {} });
    const state = makeState("impl_done");

    reconcileVisiblePlanState(planFile, [feature], [phase], state);
    const afterFirst = fs.readFileSync(planFile, "utf8");
    // Sync the in-memory gate state from what was written.
    phase.gates!.test_spec!.done = true;
    phase.gates!.verify_red!.done = true;
    phase.gates!.implementation!.done = true;
    reconcileVisiblePlanState(planFile, [feature], [phase], state);
    const afterSecond = fs.readFileSync(planFile, "utf8");

    expect(afterFirst).toBe(afterSecond);
  });

  it("skips phases with no gates object", () => {
    const planFile = _testWritePlan(
      "## Feature 1: Auth\n### Phase 1: Skeleton\n",
    );
    const phase = makePhase({ gates: undefined });
    const feature = makeFeature({ gates: {} });
    const state = makeState("committed");

    // Should not throw — phases without gates are silently skipped.
    expect(() =>
      reconcileVisiblePlanState(planFile, [feature], [phase], state),
    ).not.toThrow();
  });

  it("skips reconcile when dryRun is true", () => {
    const plan =
      [
        "## Feature 1: Auth",
        "### Phase 1: Skeleton",
        "- [ ] **Test Specification**",
        "- [ ] **Implementation**",
      ].join("\n") + "\n";
    const planFile = _testWritePlan(plan);
    const phase = makePhase({
      gates: {
        test_spec: { done: false, line: 3 },
        implementation: { done: false, line: 4 },
      },
    });
    const feature = makeFeature({ gates: {} });
    const state = makeState("committed");

    reconcileVisiblePlanState(planFile, [feature], [phase], state, {
      dryRun: true,
    });

    // Plan must not be modified in dry-run mode.
    const content = fs.readFileSync(planFile, "utf8");
    expect(content).not.toContain("[x]");
  });

  it("flips feature-level gates via featureGateProjection when feature reaches shipping", () => {
    // Feature gates (feature_review, ship_land, origin_verification) appear in the
    // feature body between the heading and the first phase heading.
    const plan =
      [
        "## Feature 1: Auth",
        "- [ ] **Feature Review (Gemini)**",
        "- [ ] **Ship & Land**",
        "- [ ] **Origin Verification**",
        "### Phase 1: Skeleton",
        "- [x] **Implementation (Gemini)**",
        "- [x] **Review & QA (Codex)**",
      ].join("\n") + "\n";

    const planFile = _testWritePlan(plan);
    const phase = makePhase({
      implementationCheckboxLine: 6,
      reviewCheckboxLine: 7,
      implementationDone: true,
      reviewDone: true,
    });
    const feature = makeFeature({
      gates: {
        feature_review: { done: false, line: 2 },
        ship_land: { done: false, line: 3 },
        origin_verification: { done: false, line: 4 },
      },
    });
    // "shipping" status → featureGateProjection returns { feature_review: true }
    const state = makeState("committed", "shipping");

    reconcileVisiblePlanState(planFile, [feature], [phase], state, {
      skipShip: false,
    });

    const lines = fs.readFileSync(planFile, "utf8").split("\n");
    expect(lines[1]).toMatch(/\[x\].*Feature Review/);
    expect(lines[2]).toMatch(/\[ \].*Ship & Land/);
    expect(lines[3]).toMatch(/\[ \].*Origin Verification/);
  });

  it("flips all three feature gates when feature reaches committed without skipShip", () => {
    const plan =
      [
        "## Feature 1: Auth",
        "- [ ] **Feature Review (Gemini)**",
        "- [ ] **Ship & Land**",
        "- [ ] **Origin Verification**",
        "### Phase 1: Skeleton",
        "- [x] **Implementation (Gemini)**",
        "- [x] **Review & QA (Codex)**",
      ].join("\n") + "\n";

    const planFile = _testWritePlan(plan);
    const phase = makePhase({
      implementationCheckboxLine: 6,
      reviewCheckboxLine: 7,
      implementationDone: true,
      reviewDone: true,
    });
    const feature = makeFeature({
      gates: {
        feature_review: { done: false, line: 2 },
        ship_land: { done: false, line: 3 },
        origin_verification: { done: false, line: 4 },
      },
    });
    // "committed" status → featureGateProjection returns all three gates
    const state = makeState("committed", "committed");

    reconcileVisiblePlanState(planFile, [feature], [phase], state, {
      skipShip: false,
    });

    const lines = fs.readFileSync(planFile, "utf8").split("\n");
    expect(lines[1]).toMatch(/\[x\].*Feature Review/);
    expect(lines[2]).toMatch(/\[x\].*Ship & Land/);
    expect(lines[3]).toMatch(/\[x\].*Origin Verification/);
  });

  it("suppresses ship_land and origin_verification when skipShip=true", () => {
    const plan =
      [
        "## Feature 1: Auth",
        "- [ ] **Feature Review (Gemini)**",
        "- [ ] **Ship & Land**",
        "- [ ] **Origin Verification**",
        "### Phase 1: Skeleton",
        "- [x] **Implementation (Gemini)**",
        "- [x] **Review & QA (Codex)**",
      ].join("\n") + "\n";

    const planFile = _testWritePlan(plan);
    const phase = makePhase({
      implementationCheckboxLine: 6,
      reviewCheckboxLine: 7,
      implementationDone: true,
      reviewDone: true,
    });
    const feature = makeFeature({
      gates: {
        feature_review: { done: false, line: 2 },
        ship_land: { done: false, line: 3 },
        origin_verification: { done: false, line: 4 },
      },
    });
    // skipShip=true + committed → only feature_review checked
    const state = makeState("committed", "committed");

    reconcileVisiblePlanState(planFile, [feature], [phase], state, {
      skipShip: true,
    });

    const lines = fs.readFileSync(planFile, "utf8").split("\n");
    expect(lines[1]).toMatch(/\[x\].*Feature Review/);
    expect(lines[2]).toMatch(/\[ \].*Ship & Land/);
    expect(lines[3]).toMatch(/\[ \].*Origin Verification/);
  });

  it("does not throw when state.features is missing", () => {
    const planFile = _testWritePlan(
      "## Feature 1: Auth\n### Phase 1: Skeleton\n",
    );
    const phase = makePhase({ gates: undefined });
    const feature = makeFeature({
      gates: { feature_review: { done: false, line: 1 } },
    });
    // Build state without a features array — the null-safety guard
    // `(state.features ?? [])[feature.index]` must not throw.
    const stateNoFeatures: BuildState = {
      ...makeState("pending", "pending"),
      features: undefined as any,
    };

    expect(() =>
      reconcileVisiblePlanState(planFile, [feature], [phase], stateNoFeatures),
    ).not.toThrow();
  });
});
