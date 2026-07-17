import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  beginRun,
  appendDecision,
  completeRun,
  configSet,
  discoverProjectIdentity,
  identityFromPaths,
  initializeProject,
  inspectProject,
  markEffectApplied,
  markEffectNotApplied,
  resumeRun,
  resolveGstackHome,
  runExternalEffect,
  setupRuntime,
  updateProjectState,
  withLock,
} from "../runtime/index.js";

const temporaryRoots: string[] = [];

async function temporaryRoot(label = "gstack2 runtime ") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), label));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) =>
    fs.chmod(root, 0o700).catch(() => {}).then(() => fs.rm(root, { recursive: true, force: true }))));
});

describe("gstack 2 host-neutral paths and state", () => {
  test("GSTACK_HOME is the only override and shell-looking paths stay literal", async () => {
    const root = await temporaryRoot();
    const configured = "state with spaces $(touch should-not-run);$HOME";
    const resolved = resolveGstackHome({
      env: { GSTACK_HOME: configured },
      cwd: root,
      homeDir: path.join(root, "fake-home"),
    });
    expect(resolved).toBe(path.join(root, configured));
    expect(resolveGstackHome({
      env: { CLAUDE_PLUGIN_DATA: "/host-specific/path" },
      cwd: root,
      homeDir: path.join(root, "person"),
    })).toBe(path.join(root, "person", ".gstack"));
    expect(await fs.readdir(root)).toEqual([]);
  });

  test("setup creates the canonical project shape and private secrets", async () => {
    const root = await temporaryRoot();
    const home = path.join(root, "home with spaces");
    const result = await setupRuntime({ home, cwd: root });
    const project = path.join(home, "projects", result.identity.projectId);
    for (const entry of [
      "state.json", "timeline.jsonl", "decisions.jsonl", "evidence", "artifacts", "reviews", "checkpoints",
    ]) {
      expect(await fs.stat(path.join(project, entry))).toBeTruthy();
    }
    if (process.platform !== "win32") {
      expect((await fs.stat(path.join(home, "secrets.json"))).mode & 0o777).toBe(0o600);
    }
  });

  test("public config rejects key, token, and credential-looking fields", async () => {
    const root = await temporaryRoot();
    const home = path.join(root, "state");
    await setupRuntime({ home, cwd: root });
    for (const key of ["context.apiKey", "context.api_key", "context.token", "service.accessToken", "service.credentials"]) {
      let error: any;
      try {
        await configSet(home, key, "must-not-be-public");
      } catch (caught) {
        error = caught;
      }
      expect(error?.code).toBe("SECRET_IN_CONFIG");
    }
  });

  test("locked concurrent updates do not lose writes", async () => {
    const root = await temporaryRoot();
    const home = path.join(root, "state");
    const identity = identityFromPaths({
      worktreeRoot: path.join(root, "repo"),
      commonDir: path.join(root, "repo", ".git"),
      gitDir: path.join(root, "repo", ".git"),
    });
    await initializeProject(home, identity);
    await Promise.all(Array.from({ length: 60 }, () =>
      updateProjectState(home, identity.projectId, (state) => {
        state.concurrentCounter = Number(state.concurrentCounter ?? 0) + 1;
      })));
    const { state } = await inspectProject(home, identity);
    expect(state.concurrentCounter).toBe(60);
    expect(state.revision).toBe(60);
  }, 15_000);

  test("crash/resume never automatically repeats an uncertain external effect", async () => {
    const root = await temporaryRoot();
    const home = path.join(root, "state");
    const identity = identityFromPaths({
      worktreeRoot: path.join(root, "repo"),
      commonDir: path.join(root, "repo", ".git"),
      gitDir: path.join(root, "repo", ".git"),
    });
    await initializeProject(home, identity);
    const { run } = await beginRun(home, identity.projectId, "ship", { runId: "run_crash_test" });
    let externalCalls = 0;
    let firstError: any;
    try {
      await runExternalEffect(home, identity.projectId, run.id, "publish.release", async () => {
        externalCalls += 1;
        // This models a connection drop after the remote service accepted the action.
        throw new Error("connection dropped after accept");
      });
    } catch (error) {
      firstError = error;
    }
    expect(firstError?.code).toBe("EXTERNAL_EFFECT_UNCERTAIN");
    await resumeRun(home, identity.projectId, run.id);
    const retried = await runExternalEffect(home, identity.projectId, run.id, "publish.release", async () => {
      externalCalls += 1;
      return "duplicated";
    });
    expect(retried.status).toBe("uncertain");
    expect(externalCalls).toBe(1);
  });

  test("completed external effects are idempotent", async () => {
    const root = await temporaryRoot();
    const home = path.join(root, "state");
    const identity = identityFromPaths({
      worktreeRoot: root,
      commonDir: path.join(root, ".git"),
      gitDir: path.join(root, ".git"),
    });
    await initializeProject(home, identity);
    const { run } = await beginRun(home, identity.projectId, "notify", { runId: "run_once" });
    let calls = 0;
    const execute = async () => ({ sequence: ++calls });
    expect((await runExternalEffect(home, identity.projectId, run.id, "notify.once", execute)).result).toEqual({ sequence: 1 });
    expect((await runExternalEffect(home, identity.projectId, run.id, "notify.once", execute)).result).toEqual({ sequence: 1 });
    expect(calls).toBe(1);
  });

  test("ambiguous effects reconcile both outcomes without permitting incomplete runs", async () => {
    const root = await temporaryRoot();
    const home = path.join(root, "state");
    const identity = identityFromPaths({
      worktreeRoot: root,
      commonDir: path.join(root, ".git"),
      gitDir: path.join(root, ".git"),
    });
    await initializeProject(home, identity);

    const appliedRun = (await beginRun(home, identity.projectId, "ship", { runId: "run_applied" })).run;
    await expect(runExternalEffect(home, identity.projectId, appliedRun.id, "git.push", async () => {
      throw new Error("connection dropped after remote accepted push");
    })).rejects.toMatchObject({ code: "EXTERNAL_EFFECT_UNCERTAIN" });
    await markEffectApplied(home, identity.projectId, appliedRun.id, "git.push", "origin/main contains commit abc123");
    await expect(completeRun(home, identity.projectId, appliedRun.id)).resolves.toBeTruthy();

    const retryRun = (await beginRun(home, identity.projectId, "ship", { runId: "run_not_applied" })).run;
    await expect(runExternalEffect(home, identity.projectId, retryRun.id, "deploy.production", async () => {
      throw new Error("preflight failed before request");
    })).rejects.toMatchObject({ code: "EXTERNAL_EFFECT_UNCERTAIN" });
    await markEffectNotApplied(home, identity.projectId, retryRun.id, "deploy.production");
    await expect(completeRun(home, identity.projectId, retryRun.id))
      .rejects.toMatchObject({ code: "EFFECTS_UNCERTAIN" });
    await runExternalEffect(home, identity.projectId, retryRun.id, "deploy.production", async () => "deployed");
    await expect(completeRun(home, identity.projectId, retryRun.id)).resolves.toBeTruthy();
  });

  test("state keys cannot collide with object prototypes and effect idempotency keys do not truncate", async () => {
    const root = await temporaryRoot();
    const home = path.join(root, "state");
    const identity = identityFromPaths({
      worktreeRoot: root,
      commonDir: path.join(root, ".git"),
      gitDir: path.join(root, ".git"),
    });
    await initializeProject(home, identity);
    await expect(beginRun(home, identity.projectId, "ship", { runId: "constructor" })).rejects.toThrow("Invalid run id");
    const { run } = await beginRun(home, identity.projectId, "ship", { runId: "run_keys" });
    await expect(runExternalEffect(home, identity.projectId, run.id, "constructor", async () => null))
      .rejects.toThrow("Invalid external effect key");

    const commonPrefix = `publish.${"a".repeat(110)}`;
    const first = await runExternalEffect(home, identity.projectId, run.id, `${commonPrefix}x`, async () => "first");
    const second = await runExternalEffect(home, identity.projectId, run.id, `${commonPrefix}y`, async () => "second");
    expect(first.idempotencyKey).toMatch(/^gstack_[0-9a-f]{64}$/);
    expect(second.idempotencyKey).toMatch(/^gstack_[0-9a-f]{64}$/);
    expect(first.idempotencyKey).not.toBe(second.idempotencyKey);
    await expect(markEffectNotApplied(home, identity.projectId, run.id, `${commonPrefix}x`))
      .rejects.toMatchObject({ code: "EFFECT_NOT_UNCERTAIN" });
  });

  test("decision provenance fields cannot be overwritten by caller input", async () => {
    const root = await temporaryRoot();
    const home = path.join(root, "state");
    const identity = identityFromPaths({
      worktreeRoot: root,
      commonDir: path.join(root, ".git"),
      gitDir: path.join(root, ".git"),
    });
    await initializeProject(home, identity);
    const record = await appendDecision(home, identity.projectId, {
      id: "forged",
      at: "1900-01-01T00:00:00.000Z",
      decision: "keep scope",
    }, { now: () => new Date("2026-07-16T12:00:00.000Z") });
    expect(record.id).not.toBe("forged");
    expect(record.at).toBe("2026-07-16T12:00:00.000Z");
  });

  test("repo identity is shared while linked worktree identity is stable and distinct", async () => {
    const root = await temporaryRoot("gstack2 worktree identity ");
    const repo = path.join(root, "main repo");
    const linked = path.join(root, "linked worktree");
    await fs.mkdir(repo);
    const git = (args: string[], cwd = repo) => spawnSync("git", args, { cwd, encoding: "utf8" });
    expect(git(["init", "--quiet", "-b", "main"]).status).toBe(0);
    git(["config", "user.email", "runtime@example.com"]);
    git(["config", "user.name", "Runtime Test"]);
    await fs.writeFile(path.join(repo, "README.md"), "runtime\n");
    git(["add", "README.md"]);
    expect(git(["commit", "--quiet", "-m", "initial"]).status).toBe(0);
    expect(git(["worktree", "add", "--quiet", "-b", "linked", linked]).status).toBe(0);

    const mainIdentity = await discoverProjectIdentity(repo);
    const linkedIdentity = await discoverProjectIdentity(linked);
    expect(linkedIdentity.repoId).toBe(mainIdentity.repoId);
    expect(linkedIdentity.worktreeId).not.toBe(mainIdentity.worktreeId);
    expect((await discoverProjectIdentity(linked)).worktreeId).toBe(linkedIdentity.worktreeId);
    expect(linkedIdentity.projectId).not.toBe(mainIdentity.projectId);
  });

  test("linked-worktree identity survives a checkout move and git infrastructure failures do not become non-git", async () => {
    const root = await temporaryRoot();
    const common = path.join(root, "repo", ".git");
    const gitDir = path.join(common, "worktrees", "feature");
    const before = identityFromPaths({ worktreeRoot: path.join(root, "old checkout"), commonDir: common, gitDir });
    const after = identityFromPaths({ worktreeRoot: path.join(root, "new checkout"), commonDir: common, gitDir });
    expect(after.repoId).toBe(before.repoId);
    expect(after.worktreeId).toBe(before.worktreeId);
    expect(after.projectId).toBe(before.projectId);

    const notGit = Object.assign(new Error("fatal: not a git repository"), {
      code: 128,
      stderr: "fatal: not a git repository",
    });
    const folder = await fs.mkdtemp(path.join(root, "plain "));
    expect((await discoverProjectIdentity(folder, { git: async () => { throw notGit; } })).isGit).toBe(false);

    const timeout = Object.assign(new Error("git timed out"), { code: "ETIMEDOUT" });
    await expect(discoverProjectIdentity(folder, { git: async () => { throw timeout; } }))
      .rejects.toMatchObject({ code: "ETIMEDOUT" });
  });

  test("setup reports a read-only destination where the platform enforces modes", async () => {
    if (process.platform === "win32" || process.getuid?.() === 0) return;
    const root = await temporaryRoot();
    const readOnly = path.join(root, "read-only");
    await fs.mkdir(readOnly, { mode: 0o500 });
    await fs.chmod(readOnly, 0o500);
    try {
      let failed = false;
      try {
        await setupRuntime({ home: path.join(readOnly, "state"), cwd: root });
      } catch (error: any) {
        failed = ["EACCES", "EPERM", "EROFS"].includes(error?.code);
      }
      expect(failed).toBe(true);
    } finally {
      await fs.chmod(readOnly, 0o700);
    }
  });

  test("lock cleanup preserves both the operation and release failures", async () => {
    const root = await temporaryRoot("gstack2 lock aggregate ");
    const lock = path.join(root, "state.lock");
    const operationError = null;
    let caught: unknown;
    try {
      await withLock(lock, async () => {
        await fs.writeFile(path.join(lock, "owner.json"), "{malformed\n");
        throw operationError;
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AggregateError);
    const failures = [...(caught as AggregateError).errors];
    expect(failures[0]).toBe(operationError);
    expect(failures[1]).toBeInstanceOf(SyntaxError);
    expect((caught as Error & { cause?: unknown }).cause).toBe(operationError);
  });
});
