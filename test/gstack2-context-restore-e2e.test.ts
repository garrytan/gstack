import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { main } from "../runtime/cli.js";
import { discoverProjectIdentity } from "../runtime/identity.js";

// ARCHITECTURE.md infrastructure row 24 ("Context restore selects another
// worktree"). The worktree-identity primitive is unit-tested elsewhere; this is
// the compatibility END-TO-END restore test: two linked worktrees of the same
// repository each save distinct canonical run state, then restore (inspect +
// resume) is driven from each worktree's own cwd through the real CLI. The CLI
// resolves identity itself via discoverProjectIdentity(cwd), so this exercises
// the actual restore selection path, not a hand-fed project id. Each restore
// must resolve to ONLY its own worktree's state and never cross-select the
// sibling worktree's run.

const temporaryRoots: string[] = [];

function sink() {
  let value = "";
  return {
    write(chunk: unknown) { value += Buffer.from(chunk as any).toString("utf8"); },
    value() { return value; },
  };
}

function git(args: string[], cwd: string) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 15_000 });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed (${result.status}): ${result.stderr || result.stdout}`);
  }
  return (result.stdout || "").trim();
}

async function run(argv: string[], cwd: string, env: Record<string, string>) {
  const stdout = sink();
  const stderr = sink();
  const code = await main(argv, { cwd, env, stdout, stderr });
  return { code, stdout: stdout.value(), stderr: stderr.value() };
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => fs.rm(root, {
    recursive: true, force: true, maxRetries: 5, retryDelay: 50,
  })));
});

describe("gstack 2 context-restore worktree scoping (ARCHITECTURE row 24)", () => {
  test("restore from each linked worktree resolves only its own saved state", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "gstack2 ctx restore e2e "));
    temporaryRoots.push(root);
    const mainCwd = path.join(root, "main-checkout");
    const linkedCwd = path.join(root, "linked-checkout");
    const home = path.join(root, "state-home");
    const env = { ...process.env, GSTACK_HOME: home } as Record<string, string>;

    await fs.mkdir(mainCwd);
    git(["init", "--quiet", "-b", "main"], mainCwd);
    git(["config", "user.name", "GStack Test"], mainCwd);
    git(["config", "user.email", "gstack@example.invalid"], mainCwd);
    // Same remote across both worktrees: repo identity is shared, only the
    // worktree identity differs. This is the exact configuration row 24 warns about.
    git(["remote", "add", "origin", "https://example.com/acme/shared-project.git"], mainCwd);
    await fs.writeFile(path.join(mainCwd, "README.md"), "shared\n");
    git(["add", "README.md"], mainCwd);
    git(["commit", "--quiet", "-m", "initial"], mainCwd);
    git(["worktree", "add", "--quiet", "-b", "feature", linkedCwd], mainCwd);

    // The identities the CLI will independently derive from each cwd.
    const mainIdentity = await discoverProjectIdentity(mainCwd);
    const linkedIdentity = await discoverProjectIdentity(linkedCwd);
    expect(mainIdentity.repoId).toBe(linkedIdentity.repoId);
    expect(mainIdentity.worktreeId).not.toBe(linkedIdentity.worktreeId);
    expect(mainIdentity.projectId).not.toBe(linkedIdentity.projectId);

    // Save distinct canonical state in each worktree, driven from its own cwd.
    expect((await run([
      "state", "begin", "review", "--run-id", "run_main", "--json",
      "--goal", "Main worktree goal", "--plan", "plans/main.md", "--mutation", "report-only",
    ], mainCwd, env)).code).toBe(0);
    expect((await run([
      "state", "begin", "ship", "--run-id", "run_linked", "--json",
      "--goal", "Linked worktree goal", "--plan", "plans/linked.md", "--mutation", "commit-push-pr",
    ], linkedCwd, env)).code).toBe(0);

    // Restore path 1: inspect the whole project from each cwd (no run id -> the
    // CLI resolves the project purely from the worktree it runs in).
    const mainInspect = await run(["state", "inspect", "--json"], mainCwd, env);
    const linkedInspect = await run(["state", "inspect", "--json"], linkedCwd, env);
    expect(mainInspect.code).toBe(0);
    expect(linkedInspect.code).toBe(0);
    const mainState = JSON.parse(mainInspect.stdout);
    const linkedState = JSON.parse(linkedInspect.stdout);

    expect(mainState.project.worktreeId).toBe(mainIdentity.worktreeId);
    expect(linkedState.project.worktreeId).toBe(linkedIdentity.worktreeId);
    expect(Object.keys(mainState.runs)).toEqual(["run_main"]);
    expect(Object.keys(linkedState.runs)).toEqual(["run_linked"]);
    expect(mainState.runs.run_linked).toBeUndefined();
    expect(linkedState.runs.run_main).toBeUndefined();

    // Restore path 2: resume WITHOUT a run id. This is the real "context restore
    // selects a worktree" moment: the runtime picks activeRunId / newest
    // incomplete run for whatever project the cwd resolves to. It must pick each
    // worktree's own run, never the sibling's.
    const mainResume = await run(["state", "resume", "--json"], mainCwd, env);
    const linkedResume = await run(["state", "resume", "--json"], linkedCwd, env);
    expect(mainResume.code).toBe(0);
    expect(linkedResume.code).toBe(0);
    const mainResumed = JSON.parse(mainResume.stdout);
    const linkedResumed = JSON.parse(linkedResume.stdout);
    expect(mainResumed.projectId).toBe(mainIdentity.projectId);
    expect(mainResumed.run.id).toBe("run_main");
    expect(mainResumed.reconstruction.originalGoal).toBe("Main worktree goal");
    expect(linkedResumed.projectId).toBe(linkedIdentity.projectId);
    expect(linkedResumed.run.id).toBe("run_linked");
    expect(linkedResumed.reconstruction.originalGoal).toBe("Linked worktree goal");

    // Cross-contamination guard: explicitly asking to restore the OTHER
    // worktree's run from this cwd must fail — the run does not exist in this
    // worktree's scoped state. If scoping regressed, this would resolve the
    // sibling's run (the exact bug row 24 describes).
    const crossFromLinked = await run(["state", "resume", "run_main", "--json"], linkedCwd, env);
    expect(crossFromLinked.code).not.toBe(0);
    expect(JSON.parse(crossFromLinked.stderr).error).toBe("RUN_NOT_FOUND");
    const crossFromMain = await run(["state", "resume", "run_linked", "--json"], mainCwd, env);
    expect(crossFromMain.code).not.toBe(0);
    expect(JSON.parse(crossFromMain.stderr).error).toBe("RUN_NOT_FOUND");

    // On-disk proof: two distinct project directories, each holding only its own run.
    const mainStateFile = path.join(home, "projects", mainIdentity.projectId, "state.json");
    const linkedStateFile = path.join(home, "projects", linkedIdentity.projectId, "state.json");
    const mainDisk = JSON.parse(await fs.readFile(mainStateFile, "utf8"));
    const linkedDisk = JSON.parse(await fs.readFile(linkedStateFile, "utf8"));
    expect(Object.keys(mainDisk.runs)).toEqual(["run_main"]);
    expect(Object.keys(linkedDisk.runs)).toEqual(["run_linked"]);
  }, 30_000);
});
