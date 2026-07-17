import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { main } from "../runtime/cli.js";
import {
  beginRun,
  completeRun,
  identityFromPaths,
  initializeProject,
  inspectRun,
  resumeRun,
  runExternalEffect,
  updateRunWorkflow,
} from "../runtime/index.js";

const temporaryRoots: string[] = [];

function sink() {
  let value = "";
  return {
    write(chunk: unknown) { value += Buffer.from(chunk as any).toString("utf8"); },
    value() { return value; },
  };
}

async function fixture(label = "gstack workflow state ", initialize = true) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), label));
  temporaryRoots.push(root);
  const home = path.join(root, "home");
  const cwd = path.join(root, "project");
  await fs.mkdir(cwd);
  const identity = identityFromPaths({
    worktreeRoot: cwd,
    commonDir: path.join(cwd, ".git"),
    gitDir: path.join(cwd, ".git"),
  });
  if (initialize) await initializeProject(home, identity);
  return { root, home, cwd, identity, env: { ...process.env, GSTACK_HOME: home } };
}

afterEach(async () => {
  for (const root of temporaryRoots.splice(0)) {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

describe("GStack 2 authoritative workflow state", () => {
  test("begin, update, inspect, and resume reconstruct the complete workflow contract", async () => {
    const { home, identity } = await fixture();
    const started = await beginRun(home, identity.projectId, "plan", {
      runId: "run_authoritative",
      originalGoal: "Ship GStack 2 without weakening specialist judgment",
      currentPlanPointer: "plans/gstack-2.md",
      currentWorkflowStage: "engineering",
      selectedDepth: "deep",
      mutationAuthority: "plan-only",
      activeModules: ["plan-eng-review", "plan-devex-review"],
      now: () => new Date("2026-07-16T10:00:00.000Z"),
    });
    expect(started.reconstruction).toMatchObject({
      currentPlan: { runId: "run_authoritative", pointer: "plans/gstack-2.md" },
      originalGoal: "Ship GStack 2 without weakening specialist judgment",
      currentGoal: "Ship GStack 2 without weakening specialist judgment",
      detourStack: [],
      currentWorkflowStage: "engineering",
      selectedDepth: "deep",
      mutationAuthority: "plan-only",
      activeModules: ["plan-eng-review", "plan-devex-review"],
      evidenceFreshness: { status: "unknown", assessedAt: null },
      evidenceProvenance: [],
      pendingApprovalGates: [],
    });

    await updateRunWorkflow(home, identity.projectId, started.run.id, {
      currentWorkflowStage: "debugging",
      mutationAuthority: "investigate-only",
      activeModules: ["investigate"],
      pushDetour: "Prove the crash-resume failure before changing code",
      addEvidenceProvenance: {
        source: "local-test",
        reference: "test/gstack2-runtime-workflow-state.test.ts",
        capturedAt: "2026-07-16T10:04:00.000Z",
      },
      evidenceFreshness: "fresh",
      addApprovalGate: {
        id: "approve-fix",
        summary: "User must authorize product-code mutation",
      },
    }, { now: () => new Date("2026-07-16T10:05:00.000Z") });

    const inspected = await inspectRun(home, identity.projectId, started.run.id);
    expect(inspected.reconstruction).toMatchObject({
      currentPlan: { runId: "run_authoritative", pointer: "plans/gstack-2.md" },
      originalGoal: "Ship GStack 2 without weakening specialist judgment",
      currentGoal: "Prove the crash-resume failure before changing code",
      currentWorkflowStage: "debugging",
      selectedDepth: "deep",
      mutationAuthority: "investigate-only",
      activeModules: ["investigate"],
      evidenceFreshness: { status: "fresh", assessedAt: "2026-07-16T10:05:00.000Z" },
      pendingApprovalGates: [{ id: "approve-fix", summary: "User must authorize product-code mutation" }],
    });
    expect(inspected.reconstruction.detourStack).toEqual([{
      goal: "Prove the crash-resume failure before changing code",
      fromStage: "engineering",
      enteredAt: "2026-07-16T10:05:00.000Z",
    }]);
    expect(inspected.reconstruction.evidenceProvenance).toEqual([{
      source: "local-test",
      reference: "test/gstack2-runtime-workflow-state.test.ts",
      capturedAt: "2026-07-16T10:04:00.000Z",
      recordedAt: "2026-07-16T10:05:00.000Z",
    }]);

    await expect(runExternalEffect(home, identity.projectId, started.run.id, "git.push", async () => "pushed"))
      .rejects.toMatchObject({ code: "APPROVAL_REQUIRED" });
    await expect(completeRun(home, identity.projectId, started.run.id))
      .rejects.toMatchObject({ code: "APPROVAL_GATES_PENDING" });

    await updateRunWorkflow(home, identity.projectId, started.run.id, {
      resolveApprovalGate: "approve-fix",
      popDetour: true,
      currentWorkflowStage: "implementation",
      mutationAuthority: "fix-safe",
      activeModules: ["investigate", "review"],
    });
    const other = await beginRun(home, identity.projectId, "qa", {
      runId: "run_other",
      currentPlanPointer: "plans/other.md",
    });
    expect(other.state.currentPlan).toMatchObject({ runId: "run_other", pointer: "plans/other.md" });
    await expect(updateRunWorkflow(home, identity.projectId, started.run.id, { currentWorkflowStage: "review" }))
      .rejects.toMatchObject({ code: "RUN_NOT_ACTIVE" });

    const resumed = await resumeRun(home, identity.projectId, started.run.id);
    expect(resumed.reconstruction).toMatchObject({
      isActive: true,
      currentPlan: { runId: "run_authoritative", pointer: "plans/gstack-2.md" },
      originalGoal: "Ship GStack 2 without weakening specialist judgment",
      detourStack: [],
      currentWorkflowStage: "implementation",
      mutationAuthority: "fix-safe",
      activeModules: ["investigate", "review"],
      pendingApprovalGates: [],
    });
  });

  test("all workflow mutations are locked and concurrent evidence writes are not lost", async () => {
    const { home, identity } = await fixture();
    await beginRun(home, identity.projectId, "qa", { runId: "run_concurrent" });
    const updates = await Promise.allSettled(Array.from({ length: 24 }, (_, index) =>
      updateRunWorkflow(home, identity.projectId, "run_concurrent", {
        addEvidenceProvenance: {
          source: "local-test",
          reference: `evidence/case-${index}.json`,
          capturedAt: `2026-07-16T10:${String(index).padStart(2, "0")}:00.000Z`,
        },
      })));
    expect(updates.filter((result) => result.status === "rejected")).toEqual([]);
    const inspected = await inspectRun(home, identity.projectId, "run_concurrent");
    expect(inspected.reconstruction.evidenceProvenance).toHaveLength(24);
    expect(new Set(inspected.reconstruction.evidenceProvenance.map((entry: any) => entry.reference)).size).toBe(24);
  });

  test("validation rejects schema confusion, prototype keys, and unsupported freshness claims", async () => {
    const { home, identity } = await fixture();
    await expect(beginRun(home, identity.projectId, "qa", {
      runId: "run_bad_depth",
      selectedDepth: "maximum",
    })).rejects.toThrow("Invalid selected depth");
    await expect(beginRun(home, identity.projectId, "qa", {
      runId: "run_bad_module",
      activeModules: ["constructor"],
    })).rejects.toThrow("Invalid active module");
    await expect(beginRun(home, identity.projectId, "qa", {
      runId: "run_bad_authority",
      mutationAuthority: "anything-goes",
    })).rejects.toThrow("Unsupported mutation authority");
    await beginRun(home, identity.projectId, "qa", { runId: "run_validation" });

    const inherited = Object.create({ currentWorkflowStage: "review" });
    await expect(updateRunWorkflow(home, identity.projectId, "run_validation", inherited))
      .rejects.toThrow("Invalid workflow transition");
    const prototypeKey = JSON.parse('{"__proto__":{"polluted":true}}');
    await expect(updateRunWorkflow(home, identity.projectId, "run_validation", prototypeKey))
      .rejects.toThrow("Unknown workflow transition field");
    await expect(updateRunWorkflow(home, identity.projectId, "run_validation", {
      originalGoal: "replace the immutable goal",
    } as any)).rejects.toThrow("Unknown workflow transition field");
    await expect(updateRunWorkflow(home, identity.projectId, "run_validation", {
      evidenceFreshness: "fresh",
    })).rejects.toThrow("Fresh evidence requires provenance");

    const inspected = await inspectRun(home, identity.projectId, "run_validation");
    expect(inspected.reconstruction.originalGoal).toBe("qa");
    expect(inspected.reconstruction.evidenceFreshness).toEqual({ status: "unknown", assessedAt: null });
    expect(({} as any).polluted).toBeUndefined();

    await beginRun(home, identity.projectId, "review", {
      runId: "run_report_only",
      mutationAuthority: "report-only",
    });
    await expect(runExternalEffect(home, identity.projectId, "run_report_only", "git.push", async () => "pushed"))
      .rejects.toMatchObject({ code: "MUTATION_NOT_AUTHORIZED" });
  });

  test("the CLI persists and reconstructs every workflow field across independent invocations", async () => {
    const { cwd, env } = await fixture("gstack workflow CLI ", false);
    const beginOut = sink();
    const beginErr = sink();
    expect(await main([
      "state", "begin", "review", "--run-id", "run_cli_state", "--json",
      "--goal", "Review the release boundary", "--plan", "plans/release.md",
      "--stage", "triage", "--depth", "deep", "--mutation", "report-only",
      "--modules", "review,cso",
    ], { cwd, env, stdout: beginOut, stderr: beginErr })).toBe(0);
    expect(JSON.parse(beginOut.value()).reconstruction.originalGoal).toBe("Review the release boundary");

    const updateOut = sink();
    expect(await main([
      "state", "update", "run_cli_state",
      "--stage", "security-review", "--mutation", "investigate-only", "--modules", "cso",
      "--push-detour", "Audit the credential boundary",
      "--evidence-source", "local-test", "--evidence-reference", "evidence/security.json",
      "--evidence-captured-at", "2026-07-16T12:00:00.000Z", "--evidence-freshness", "fresh",
      "--add-approval", "approve-remediation", "--approval-summary", "Authorize remediation",
    ], { cwd, env, stdout: updateOut, stderr: sink() })).toBe(0);
    expect(JSON.parse(updateOut.value()).reconstruction.pendingApprovalGates[0].id).toBe("approve-remediation");

    const inspectOut = sink();
    expect(await main(["state", "inspect", "run_cli_state", "--json"], {
      cwd, env, stdout: inspectOut, stderr: sink(),
    })).toBe(0);
    const reconstructed = JSON.parse(inspectOut.value()).reconstruction;
    expect(reconstructed).toMatchObject({
      currentPlan: { runId: "run_cli_state", pointer: "plans/release.md" },
      originalGoal: "Review the release boundary",
      currentWorkflowStage: "security-review",
      selectedDepth: "deep",
      mutationAuthority: "investigate-only",
      activeModules: ["cso"],
      evidenceFreshness: { status: "fresh" },
      pendingApprovalGates: [{ id: "approve-remediation", summary: "Authorize remediation" }],
    });
    expect(reconstructed.detourStack[0].goal).toBe("Audit the credential boundary");
    expect(reconstructed.evidenceProvenance[0].reference).toBe("evidence/security.json");

    const resumeOut = sink();
    expect(await main(["state", "resume", "run_cli_state", "--json"], {
      cwd, env, stdout: resumeOut, stderr: sink(),
    })).toBe(0);
    const resumed = JSON.parse(resumeOut.value()).reconstruction;
    expect(resumed).toMatchObject({
      originalGoal: reconstructed.originalGoal,
      currentWorkflowStage: reconstructed.currentWorkflowStage,
      selectedDepth: reconstructed.selectedDepth,
      mutationAuthority: reconstructed.mutationAuthority,
      activeModules: reconstructed.activeModules,
      detourStack: reconstructed.detourStack,
      evidenceFreshness: reconstructed.evidenceFreshness,
      evidenceProvenance: reconstructed.evidenceProvenance,
      pendingApprovalGates: reconstructed.pendingApprovalGates,
    });
    expect(resumed.currentPlan).toMatchObject({ runId: "run_cli_state", pointer: "plans/release.md" });
  });

  test("a completed transition survives abrupt process exit and old runs reconstruct safely", async () => {
    const { home, cwd, identity } = await fixture("gstack workflow crash ");
    const runtimeUrl = pathToFileURL(path.resolve(import.meta.dir, "../runtime/index.js")).href;
    const script = `
      const runtime = await import(${JSON.stringify(runtimeUrl)});
      const identity = runtime.identityFromPaths(${JSON.stringify({
        worktreeRoot: cwd,
        commonDir: path.join(cwd, ".git"),
        gitDir: path.join(cwd, ".git"),
      })});
      await runtime.beginRun(${JSON.stringify(home)}, identity.projectId, "ship", {
        runId: "run_crash_metadata",
        originalGoal: "Land only after approval",
        currentPlanPointer: "plans/ship.md",
        currentWorkflowStage: "preflight",
        selectedDepth: "deep",
        mutationAuthority: "commit-push-pr",
        activeModules: ["ship"]
      });
      await runtime.updateRunWorkflow(${JSON.stringify(home)}, identity.projectId, "run_crash_metadata", {
        addApprovalGate: { id: "approve-push", summary: "Approve the push" },
        currentWorkflowStage: "awaiting-approval"
      });
      process.exit(23);
    `;
    const child = spawnSync(process.execPath, ["-e", script], { encoding: "utf8" });
    expect(child.status).toBe(23);
    const afterCrash = await inspectRun(home, identity.projectId, "run_crash_metadata");
    expect(afterCrash.reconstruction).toMatchObject({
      currentPlan: { pointer: "plans/ship.md" },
      originalGoal: "Land only after approval",
      currentWorkflowStage: "awaiting-approval",
      selectedDepth: "deep",
      mutationAuthority: "commit-push-pr",
      activeModules: ["ship"],
      pendingApprovalGates: [{ id: "approve-push", summary: "Approve the push" }],
    });

    const stateFile = afterCrash.paths.state;
    const raw = JSON.parse(await fs.readFile(stateFile, "utf8"));
    delete raw.runs.run_crash_metadata.workflow;
    delete raw.currentPlan;
    await fs.writeFile(stateFile, `${JSON.stringify(raw, null, 2)}\n`);
    const legacy = await inspectRun(home, identity.projectId, "run_crash_metadata");
    expect(legacy.reconstruction).toMatchObject({
      originalGoal: "ship",
      currentWorkflowStage: "initialized",
      selectedDepth: "standard",
      mutationAuthority: "source-defined",
      evidenceFreshness: { status: "unknown", assessedAt: null },
      pendingApprovalGates: [],
    });
    await resumeRun(home, identity.projectId, "run_crash_metadata");
    const persisted = JSON.parse(await fs.readFile(stateFile, "utf8"));
    expect(persisted.runs.run_crash_metadata.workflow.originalGoal).toBe("ship");
  });
});
