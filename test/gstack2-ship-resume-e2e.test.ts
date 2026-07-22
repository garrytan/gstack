import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import { appendFileSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import {
  completeRun,
  identityFromPaths,
  initializeProject,
  inspectRun,
  markEffectApplied,
  resumeRun,
  runExternalEffect,
} from "../runtime/index.js";

const ROOT = path.resolve(import.meta.dir, "..");
const RUNTIME_INDEX_URL = pathToFileURL(path.join(ROOT, "runtime", "index.js")).href;
const temporaryRoots: string[] = [];

async function temporaryRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gstack2 ship resume "));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  for (const root of temporaryRoots.splice(0)) {
    await fs.chmod(root, 0o700).catch(() => {});
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

// A ship-style run performed in a real child process that (1) records a push,
// advances a workflow stage, then (2) performs the external tag effect and is
// SIGKILLed BETWEEN that effect and its completion record. runExternalEffect
// commits the durable in_progress claim and releases the lock before execute()
// runs, so the on-disk state after the kill is a genuine mid-flight crash.
const CHILD_SCRIPT = `
import fs from "node:fs";
import {
  beginRun,
  identityFromPaths,
  runExternalEffect,
  updateRunWorkflow,
} from ${JSON.stringify(RUNTIME_INDEX_URL)};

const [home, worktreeRoot, gitCommon, runId, logPath] = process.argv.slice(2);
const identity = identityFromPaths({ worktreeRoot, commonDir: gitCommon, gitDir: gitCommon });

await beginRun(home, identity.projectId, "ship", { runId });

await runExternalEffect(home, identity.projectId, runId, "git.push", async () => {
  fs.appendFileSync(logPath, "push\\n");
  return "pushed";
});

// A durable workflow record that must survive the crash.
await updateRunWorkflow(home, identity.projectId, runId, { currentWorkflowStage: "publishing" });

await runExternalEffect(home, identity.projectId, runId, "git.tag", async () => {
  fs.appendFileSync(logPath, "tag\\n");
  // Crash after the external system accepted the action but before the
  // completion record is written. The claim is already durable on disk.
  process.kill(process.pid, "SIGKILL");
  return "tagged"; // never reached
});
`;

describe("gstack 2 end-to-end ship resume idempotency", () => {
  test("a ship crashed between an external effect and its record resumes without repeating it", async () => {
    const root = await temporaryRoot();
    const home = path.join(root, "state");
    const worktreeRoot = path.join(root, "repo");
    const gitCommon = path.join(worktreeRoot, ".git");
    const logPath = path.join(root, "external-effects.log");
    const runId = "run_ship_e2e";
    const childScript = path.join(root, "ship-crash-child.mjs");

    const identity = identityFromPaths({ worktreeRoot, commonDir: gitCommon, gitDir: gitCommon });
    await initializeProject(home, identity);
    await fs.writeFile(childScript, CHILD_SCRIPT, "utf8");

    // Drive the first part of the ship in a separate process and let it crash.
    const child = spawnSync(process.execPath, [childScript, home, worktreeRoot, gitCommon, runId, logPath], {
      encoding: "utf8",
      timeout: 20_000,
    });
    // The process died to the injected SIGKILL, not a clean exit or a runtime error.
    expect(child.signal).toBe("SIGKILL");

    // Both external effects executed exactly once before the crash.
    expect(readFileSync(logPath, "utf8").trim().split("\n")).toEqual(["push", "tag"]);

    // Resume from durable state in this (fresh) process.
    const resumed = await resumeRun(home, identity.projectId, runId);
    expect(resumed.run.status).toBe("running");
    // The workflow stage recorded before the crash survived.
    expect(resumed.reconstruction.currentWorkflowStage).toBe("publishing");
    // The interrupted tag claim is now uncertain, never silently retried.
    expect(resumed.reconstruction.effects["git.tag"].status).toBe("uncertain");
    expect(resumed.reconstruction.effects["git.push"].status).toBe("completed");

    // Re-issuing the uncertain effect does NOT execute it again.
    const retriedTag = await runExternalEffect(home, identity.projectId, runId, "git.tag", async () => {
      appendFileSync(logPath, "tag\n");
      return "re-tagged";
    });
    expect(retriedTag.status).toBe("uncertain");
    expect(retriedTag.repeated).toBe(false);

    // Re-issuing the already-completed push is idempotent (repeated, not re-run).
    const retriedPush = await runExternalEffect(home, identity.projectId, runId, "git.push", async () => {
      appendFileSync(logPath, "push\n");
      return "re-pushed";
    });
    expect(retriedPush.status).toBe("completed");
    expect(retriedPush.repeated).toBe(true);

    // External inspection confirmed the tag landed; reconcile it as applied.
    await markEffectApplied(home, identity.projectId, runId, "git.tag", "refs/tags/v1 present on origin");

    // Finish the remaining ship step and complete the run.
    const deploy = await runExternalEffect(home, identity.projectId, runId, "deploy.production", async () => {
      appendFileSync(logPath, "deploy\n");
      return "deployed";
    });
    expect(deploy.status).toBe("completed");
    expect(deploy.repeated).toBe(false);

    const completed = await completeRun(home, identity.projectId, runId);
    expect(completed.run.status).toBe("completed");

    // At-most-once end to end: every external effect ran exactly once despite
    // the crash, the resume, and the explicit retries.
    expect(readFileSync(logPath, "utf8").trim().split("\n")).toEqual(["push", "tag", "deploy"]);

    // The completed run has no unresolved effects and is durably terminal.
    const final = await inspectRun(home, identity.projectId, runId);
    expect(final.run.status).toBe("completed");
    for (const effect of Object.values(final.run.effects)) {
      expect(effect.status).toBe("completed");
    }
  }, 25_000);
});
