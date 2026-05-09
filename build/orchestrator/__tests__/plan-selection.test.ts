import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { writeActiveRunRecord } from "../active-runs";
import {
  canonicalSourcePlanClaimPath,
  legacySourcePlanClaimPath,
} from "../plan-claims";
import {
  createSourcePlanClaim,
  renderPlanStatusTable,
  resolvePlanSelection,
} from "../plan-selection";
import type { BuildRunManifest, BuildState } from "../types";

let tmpDir = "";
let oldStateDir: string | undefined;

function mkdirp(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function write(filePath: string, body: string): string {
  mkdirp(path.dirname(filePath));
  fs.writeFileSync(filePath, body);
  return filePath;
}

function writeJson(filePath: string, value: unknown): string {
  return write(filePath, JSON.stringify(value, null, 2) + "\n");
}

function gstackRepo(): string {
  const repo = path.join(tmpDir, "app-gstack");
  mkdirp(path.join(repo, "inbox", "living-plan"));
  mkdirp(path.join(repo, "inbox", ".claims"));
  return repo;
}

function sourcePlan(repo: string, name = "feature-plan-1.md"): string {
  return write(path.join(repo, "inbox", name), "# Plan\n");
}

function livingPlan(repo: string, name = "app-impl-plan-feature-1.md"): string {
  return write(path.join(repo, "inbox", "living-plan", name), "# Living\n- [ ] **Implementation**\n");
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gstack-plan-selection-"));
  oldStateDir = process.env.GSTACK_BUILD_STATE_DIR;
  process.env.GSTACK_BUILD_STATE_DIR = path.join(tmpDir, "state");
});

afterEach(() => {
  if (oldStateDir) process.env.GSTACK_BUILD_STATE_DIR = oldStateDir;
  else delete process.env.GSTACK_BUILD_STATE_DIR;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("canonical source-plan claims", () => {
  test("same basename in different directories gets different canonical claim ids", () => {
    const repo = gstackRepo();
    const a = path.join(repo, "inbox", "feature-plan-1.md");
    const b = path.join(tmpDir, "external", "feature-plan-1.md");

    expect(canonicalSourcePlanClaimPath(repo, a)).not.toBe(
      canonicalSourcePlanClaimPath(repo, b),
    );
    expect(canonicalSourcePlanClaimPath(repo, a)).toContain("feature-plan-1-");
  });

  test("legacy basename claims are still read and block duplicate synthesis", () => {
    const repo = gstackRepo();
    const plan = sourcePlan(repo);
    writeJson(legacySourcePlanClaimPath(repo, plan), {
      runGroupId: "legacy",
      sourcePlanPath: plan,
      pid: process.pid,
      status: "claimed",
    });

    const result = resolvePlanSelection({ gstackRepo: repo });

    expect(result.result).toBe("blocked");
    expect(result.candidates[0].legacyClaimPath).toBe(
      legacySourcePlanClaimPath(repo, plan),
    );
  });

  test("createSourcePlanClaim writes canonical claim with exclusive create", () => {
    const repo = gstackRepo();
    const plan = sourcePlan(repo);

    const first = createSourcePlanClaim({
      gstackRepo: repo,
      sourcePlanPath: plan,
      runGroupId: "run-group",
      hostname: "host",
      pid: 12345,
      now: new Date("2026-05-09T00:00:00Z"),
    });
    const second = createSourcePlanClaim({
      gstackRepo: repo,
      sourcePlanPath: plan,
      runGroupId: "other",
    });

    expect(first.ok).toBe(true);
    expect(first.claimPath).toBe(canonicalSourcePlanClaimPath(repo, plan));
    expect(second.ok).toBe(false);
    expect(second.existingClaimPath).toBe(first.claimPath);
  });
});

describe("plan resolver", () => {
  test("one unclaimed source plan auto-selects", () => {
    const repo = gstackRepo();
    const plan = sourcePlan(repo);

    const result = resolvePlanSelection({ gstackRepo: repo });

    expect(result.result).toBe("selected");
    expect(result.selected?.path).toBe(plan);
    expect(result.selected?.claimPath).toBe(canonicalSourcePlanClaimPath(repo, plan));
    expect(result.commands).toEqual([`/build ${plan}`]);
  });

  test("multiple unclaimed source plans are ambiguous, not newest-selected", () => {
    const repo = gstackRepo();
    sourcePlan(repo, "a-plan-1.md");
    sourcePlan(repo, "b-plan-1.md");

    const result = resolvePlanSelection({ gstackRepo: repo });

    expect(result.result).toBe("ambiguous");
    expect(result.candidates).toHaveLength(2);
  });

  test("--all-inbox filters out claimed source plans", () => {
    const repo = gstackRepo();
    const claimed = sourcePlan(repo, "claimed-plan-1.md");
    const open = sourcePlan(repo, "open-plan-1.md");
    writeJson(canonicalSourcePlanClaimPath(repo, claimed), {
      sourcePlanPath: claimed,
      pid: process.pid,
      status: "claimed",
    });

    const result = resolvePlanSelection({ gstackRepo: repo, allInbox: true });

    expect(result.result).toBe("selected");
    expect(result.selected?.path).toBe(open);
  });

  test("--all-inbox selects every unclaimed source plan instead of treating them as ambiguous", () => {
    const repo = gstackRepo();
    const first = sourcePlan(repo, "first-plan-1.md");
    const second = sourcePlan(repo, "second-plan-1.md");

    const result = resolvePlanSelection({ gstackRepo: repo, allInbox: true });

    expect(result.result).toBe("selected");
    expect(result.reason).toContain("all unclaimed inbox");
    expect(result.candidates.map((candidate) => candidate.path).sort()).toEqual([
      first,
      second,
    ].sort());
    expect(result.candidates.every((candidate) => candidate.claimPath)).toBe(true);
  });

  test("explicit source path wins after validation", () => {
    const repo = gstackRepo();
    const inbox = sourcePlan(repo, "inbox-plan-1.md");
    const explicit = write(path.join(tmpDir, "chosen-plan-1.md"), "# Explicit\n");

    const result = resolvePlanSelection({
      gstackRepo: repo,
      explicitPaths: [explicit],
    });

    expect(result.result).toBe("selected");
    expect(result.selected?.path).toBe(explicit);
    expect(result.selected?.path).not.toBe(inbox);
  });

  test("repo-scoped resume ignores living plans for another product repo", () => {
    const repo = gstackRepo();
    const appA = path.join(tmpDir, "app-a");
    const appB = path.join(tmpDir, "app-b");
    const planA = livingPlan(repo, "app-a-impl-plan-feature-1.md");
    const planB = livingPlan(repo, "app-b-impl-plan-feature-1.md");
    writeManifest(repo, [
      manifestRun({ repoPath: appA, livingPlanPath: planA, runId: "run-a" }),
      manifestRun({ repoPath: appB, livingPlanPath: planB, runId: "run-b" }),
    ]);

    const result = resolvePlanSelection({
      gstackRepo: repo,
      projectRoot: appA,
      resumeOnly: true,
    });

    expect(result.result).toBe("selected");
    expect(result.selected?.runId).toBe("run-a");
  });

  test("active run records without manifests are resumable and scoped to the current repo", () => {
    const repo = gstackRepo();
    const app = path.join(tmpDir, "app");
    const other = path.join(tmpDir, "other");
    const activeRunRegistry = path.join(tmpDir, "active-runs");
    const plan = livingPlan(repo, "app-impl-plan-feature-1.md");
    const otherPlan = livingPlan(repo, "other-impl-plan-feature-1.md");
    writeActiveRunRecord(activeRunRegistry, {
      runId: "run-a",
      stateSlug: "state-a",
      repoPath: path.join(tmpDir, "worktrees", "run-a"),
      baseProjectRoot: app,
      planFile: plan,
      pid: process.pid,
      status: "running",
      startedAt: "2026-05-09T00:00:00Z",
      lastUpdatedAt: "2026-05-09T00:00:00Z",
      branches: [],
    });
    writeActiveRunRecord(activeRunRegistry, {
      runId: "run-b",
      stateSlug: "state-b",
      repoPath: path.join(tmpDir, "worktrees", "run-b"),
      baseProjectRoot: other,
      planFile: otherPlan,
      pid: process.pid,
      status: "running",
      startedAt: "2026-05-09T00:00:00Z",
      lastUpdatedAt: "2026-05-09T00:00:00Z",
      branches: [],
    });

    const result = resolvePlanSelection({
      gstackRepo: repo,
      projectRoot: app,
      resumeOnly: true,
      activeRunRegistry,
    });

    expect(result.result).toBe("selected");
    expect(result.selected?.runId).toBe("run-a");
    expect(result.selected?.command).toBe("/build --resume run-a");
  });

  test("active duplicate run prevents auto-selecting a new source plan", () => {
    const repo = gstackRepo();
    const app = path.join(tmpDir, "app");
    const activeRunRegistry = path.join(tmpDir, "active-runs");
    const source = sourcePlan(repo);
    const plan = livingPlan(repo);
    writeActiveRunRecord(activeRunRegistry, {
      runId: "run-a",
      stateSlug: "state-a",
      repoPath: path.join(tmpDir, "worktrees", "run-a"),
      baseProjectRoot: app,
      planFile: plan,
      pid: process.pid,
      status: "running",
      startedAt: "2026-05-09T00:00:00Z",
      lastUpdatedAt: "2026-05-09T00:00:00Z",
      branches: [],
    });

    const result = resolvePlanSelection({
      gstackRepo: repo,
      projectRoot: app,
      activeRunRegistry,
    });

    expect(result.result).toBe("ambiguous");
    expect(result.commands).toContain(`/build ${source}`);
    expect(result.commands).toContain("/build --resume run-a");
  });

  test("malformed manifests are reported without hiding good candidates", () => {
    const repo = gstackRepo();
    const plan = sourcePlan(repo);
    write(path.join(repo, ".llm-tmp", "build-runs", "bad", "build-run-manifest.json"), "{");

    const result = resolvePlanSelection({ gstackRepo: repo });

    expect(result.result).toBe("selected");
    expect(result.selected?.path).toBe(plan);
    expect(result.errors[0]).toContain("build-run-manifest.json");
  });

  test("human table includes commands and monitor commands", () => {
    const repo = gstackRepo();
    const app = path.join(tmpDir, "app");
    const plan = livingPlan(repo);
    const manifestPath = writeManifest(repo, [
      manifestRun({ repoPath: app, livingPlanPath: plan, runId: "run-a" }),
    ]);

    const result = resolvePlanSelection({
      gstackRepo: repo,
      projectRoot: app,
      resumeOnly: true,
    });
    const table = renderPlanStatusTable(result);

    expect(table).toContain("Result: selected");
    expect(table).toContain("/build --resume run-a");
    expect(table).toContain(`gstack-build monitor --manifest ${manifestPath} --watch`);
  });
});

function manifestRun(args: {
  repoPath: string;
  livingPlanPath: string;
  runId: string;
}): BuildRunManifest["runs"][number] {
  return {
    runId: args.runId,
    repoPath: args.repoPath,
    repoSlug: path.basename(args.repoPath),
    livingPlanPath: args.livingPlanPath,
    worktreePath: path.join(tmpDir, "worktrees", args.runId),
    stateSlug: `build-${args.runId}`,
    branchPrefix: `${path.basename(args.repoPath)}-${args.runId}`,
    pidFile: path.join(tmpDir, "runs", args.runId, "pid"),
    stdoutLog: path.join(tmpDir, "runs", args.runId, "stdout.log"),
    launchCommand: [
      "gstack-build",
      args.livingPlanPath,
      "--run-id",
      args.runId,
      "--active-run-registry",
      path.join(tmpDir, "active-runs"),
    ],
  };
}

function writeManifest(
  repo: string,
  runs: BuildRunManifest["runs"],
): string {
  const manifestPath = path.join(
    repo,
    ".llm-tmp",
    "build-runs",
    "group",
    "build-run-manifest.json",
  );
  writeJson(manifestPath, {
    manifestId: "manifest",
    runGroupId: "group",
    tmpDir: path.dirname(manifestPath),
    gstackRepo: repo,
    runs,
  } satisfies BuildRunManifest);
  for (const run of runs) {
    const state: BuildState = {
      planFile: run.livingPlanPath,
      planBasename: path.basename(run.livingPlanPath, ".md"),
      slug: run.stateSlug,
      branch: "main",
      startedAt: "2026-05-09T00:00:00Z",
      lastUpdatedAt: "2026-05-09T00:00:00Z",
      launch: {
        argv: run.launchCommand,
        projectRoot: run.worktreePath,
        baseProjectRoot: run.repoPath,
        runId: run.runId,
        stateSlug: run.stateSlug,
        dryRun: false,
        skipShip: false,
        skipFeatureReview: false,
        launchedAt: "2026-05-09T00:00:00Z",
      },
      currentPhaseIndex: 0,
      currentFeatureIndex: 0,
      phases: [],
      features: [],
      completed: false,
    };
    writeJson(path.join(process.env.GSTACK_BUILD_STATE_DIR!, `${run.stateSlug}.json`), state);
  }
  return manifestPath;
}
