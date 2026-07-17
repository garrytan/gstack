import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = path.resolve(import.meta.dir, "..");
const BIN = path.join(ROOT, "bin");
const temporaryRoots: string[] = [];

function run(command: string, args: string[], cwd: string, home?: string) {
  const env = {
    ...process.env,
    ...(home ? { GSTACK_HOME: home, GSTACK_STATE_ROOT: home } : {}),
    GSTACK_QUESTION_LOG_NO_DERIVE: "1",
  };
  const result = spawnSync(command, args, { cwd, env, encoding: "utf8", timeout: 15_000 });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed (${result.status}): ${result.stderr || result.stdout}`);
  }
  return result.stdout || "";
}

function helper(name: string, args: string[], cwd: string, home: string) {
  return run(path.join(BIN, name), args, cwd, home);
}

function parseIdentity(cwd: string, home: string) {
  const output = helper("gstack-slug", [], cwd, home);
  const value = (key: string) => output.match(new RegExp(`^${key}=([a-zA-Z0-9._-]+)$`, "m"))?.[1] ?? "unknown";
  return {
    slug: value("SLUG"),
    projectId: value("PROJECT_ID"),
    repoId: value("REPO_ID"),
    worktreeId: value("WORKTREE_ID"),
  };
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("preserved helper project-state identity", () => {
  test("all paired local project readers and writers use PROJECT_ID, not SLUG", () => {
    const helpers = [
      "gstack-timeline-log", "gstack-timeline-read",
      "gstack-learnings-log", "gstack-learnings-search",
      "gstack-question-log", "gstack-question-preference",
      "gstack-review-log", "gstack-review-read", "gstack-specialist-stats",
      "gstack-distill-free-text", "gstack-distill-apply", "gstack-developer-profile",
    ];
    for (const name of helpers) {
      const source = fs.readFileSync(path.join(BIN, name), "utf8");
      expect(source).not.toMatch(/projects\/\$\{?SLUG\}?/);
    }
    const hook = fs.readFileSync(path.join(ROOT, "hosts", "claude", "hooks", "question-preference-hook.ts"), "utf8");
    expect(hook).not.toContain("slugFromCwd");
    expect(hook).toContain("discoverProjectIdentity");
  });

  test("identity infrastructure failures never collapse writes into projects/unknown", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "gstack-helper-identity-failure-"));
    temporaryRoots.push(root);
    const cwd = path.join(root, "checkout");
    const home = path.join(root, "state");
    const fakeBin = path.join(root, "fake-bin");
    fs.mkdirSync(cwd);
    fs.mkdirSync(fakeBin);
    const fakeGit = path.join(fakeBin, "git");
    fs.writeFileSync(fakeGit, "#!/bin/sh\nexit 2\n", { mode: 0o755 });
    const result = spawnSync(path.join(BIN, "gstack-timeline-log"), [JSON.stringify({ skill: "qa", event: "completed" })], {
      cwd,
      env: {
        ...process.env,
        GSTACK_HOME: home,
        PATH: [fakeBin, process.env.PATH || ""].join(path.delimiter),
      },
      encoding: "utf8",
    });
    expect(result.status).not.toBe(0);
    expect(fs.existsSync(path.join(home, "projects", "unknown"))).toBe(false);
  });

  test("linked worktrees with the same remote never share local helper state", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "gstack-helper-worktrees-"));
    temporaryRoots.push(root);
    const main = path.join(root, "main checkout");
    const linked = path.join(root, "linked checkout");
    const home = path.join(root, "state home");
    fs.mkdirSync(main);

    run("git", ["init", "--quiet", "-b", "main"], main);
    run("git", ["config", "user.name", "GStack Test"], main);
    run("git", ["config", "user.email", "gstack@example.com"], main);
    run("git", ["remote", "add", "origin", "https://example.com/acme/shared-project.git"], main);
    for (let index = 1; index <= 5; index += 1) {
      fs.writeFileSync(path.join(main, "counter.txt"), `${index}\n`);
      run("git", ["add", "counter.txt"], main);
      run("git", ["commit", "--quiet", "-m", `commit ${index}`], main);
    }
    run("git", ["worktree", "add", "--quiet", "-b", "feature", linked], main);

    const mainIdentity = parseIdentity(main, home);
    const linkedIdentity = parseIdentity(linked, home);
    expect(mainIdentity.slug).toBe("acme-shared-project");
    expect(linkedIdentity.slug).toBe(mainIdentity.slug);
    expect(linkedIdentity.repoId).toBe(mainIdentity.repoId);
    expect(linkedIdentity.worktreeId).not.toBe(mainIdentity.worktreeId);
    expect(linkedIdentity.projectId).not.toBe(mainIdentity.projectId);

    helper("gstack-timeline-log", [JSON.stringify({ skill: "qa", event: "completed", branch: "main" })], main, home);
    helper("gstack-timeline-log", [JSON.stringify({ skill: "review", event: "completed", branch: "feature" })], linked, home);
    helper("gstack-learnings-log", [JSON.stringify({ skill: "qa", type: "pattern", key: "main-only", insight: "main insight", confidence: 8, source: "observed" })], main, home);
    helper("gstack-learnings-log", [JSON.stringify({ skill: "review", type: "pattern", key: "linked-only", insight: "linked insight", confidence: 8, source: "observed" })], linked, home);
    helper("gstack-review-log", [JSON.stringify({ skill: "review", status: "main", specialists: { security: { dispatched: true, findings: 1 } } })], main, home);
    helper("gstack-review-log", [JSON.stringify({ skill: "review", status: "linked", specialists: { performance: { dispatched: true, findings: 2 } } })], linked, home);
    helper("gstack-decision-log", [JSON.stringify({ decision: "main decision", scope: "repo", source: "user" })], main, home);
    helper("gstack-decision-log", [JSON.stringify({ decision: "linked decision", scope: "repo", source: "user" })], linked, home);

    const question = (id: string) => JSON.stringify({
      skill: "plan", question_id: id, question_summary: `${id} summary`, options_count: 2,
      user_choice: "yes", recommended: "yes", session_id: id,
    });
    helper("gstack-question-log", [question("main-question")], main, home);
    helper("gstack-question-log", [question("linked-question")], linked, home);
    helper("gstack-question-preference", ["--write", JSON.stringify({ question_id: "main-pref", preference: "never-ask", source: "plan-tune" })], main, home);
    helper("gstack-question-preference", ["--write", JSON.stringify({ question_id: "linked-pref", preference: "always-ask", source: "plan-tune" })], linked, home);
    helper("gstack-taste-update", ["approved", "main-variant", "--reason", "fonts: Main Sans"], main, home);
    helper("gstack-taste-update", ["approved", "linked-variant", "--reason", "fonts: Linked Sans"], linked, home);
    helper("gstack-repo-mode", [], main, home);
    helper("gstack-repo-mode", [], linked, home);
    helper("gstack-brain-cache", ["invalidate", "product", "--project", mainIdentity.slug], main, home);
    helper("gstack-brain-cache", ["invalidate", "product", "--project", linkedIdentity.slug], linked, home);

    const mainDir = path.join(home, "projects", mainIdentity.projectId);
    const linkedDir = path.join(home, "projects", linkedIdentity.projectId);
    for (const dir of [mainDir, linkedDir]) expect(fs.statSync(dir).isDirectory()).toBe(true);
    expect(fs.existsSync(path.join(home, "projects", mainIdentity.slug))).toBe(false);

    expect(helper("gstack-timeline-read", [], main, home)).toContain("/qa completed");
    expect(helper("gstack-timeline-read", [], main, home)).not.toContain("/review completed");
    expect(helper("gstack-timeline-read", [], linked, home)).toContain("/review completed");
    expect(helper("gstack-learnings-search", [], main, home)).toContain("main-only");
    expect(helper("gstack-learnings-search", [], main, home)).not.toContain("linked-only");
    expect(helper("gstack-learnings-search", [], linked, home)).toContain("linked-only");

    expect(JSON.parse(helper("gstack-decision-search", ["--json"], main, home))).toEqual([
      expect.objectContaining({ decision: "main decision" }),
    ]);
    expect(JSON.parse(helper("gstack-decision-search", ["--json"], linked, home))).toEqual([
      expect.objectContaining({ decision: "linked decision" }),
    ]);
    expect(helper("gstack-review-read", [], main, home)).toContain('"status":"main"');
    expect(helper("gstack-review-read", [], main, home)).not.toContain('"status":"linked"');
    expect(helper("gstack-specialist-stats", [], main, home)).toContain("security: 1/1 dispatched");
    expect(helper("gstack-specialist-stats", [], main, home)).not.toContain("performance:");
    expect(JSON.parse(helper("gstack-question-preference", ["--read"], main, home))).toEqual({ "main-pref": "never-ask" });
    expect(JSON.parse(helper("gstack-question-preference", ["--read"], linked, home))).toEqual({ "linked-pref": "always-ask" });

    expect(fs.readFileSync(path.join(mainDir, "question-log.jsonl"), "utf8")).toContain("main-question");
    expect(fs.readFileSync(path.join(mainDir, "question-log.jsonl"), "utf8")).not.toContain("linked-question");
    expect(fs.readFileSync(path.join(mainDir, "taste-profile.json"), "utf8")).toContain("Main Sans");
    expect(fs.readFileSync(path.join(mainDir, "taste-profile.json"), "utf8")).not.toContain("Linked Sans");
    expect(fs.existsSync(path.join(mainDir, "repo-mode.json"))).toBe(true);
    expect(fs.existsSync(path.join(linkedDir, "repo-mode.json"))).toBe(true);
    expect(fs.existsSync(path.join(mainDir, "brain-cache", "_meta.json"))).toBe(true);
    expect(fs.existsSync(path.join(linkedDir, "brain-cache", "_meta.json"))).toBe(true);
  }, 30_000);
});
