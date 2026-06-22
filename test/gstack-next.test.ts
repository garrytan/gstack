import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyFiles, decideNext } from "../bin/gstack-next";

const baseInput = {
  cwd: "/Users/sawbeck/Projects/example",
  branch: "codex/example",
  baseBranch: "main",
  isGitRepo: true,
  protectedBranch: false,
  dirty: false,
  changedFiles: [] as string[],
  cleanReviewAtHead: false,
  pr: null,
  repoName: "example",
  profile: "default" as const,
};

const sawyerInput = {
  ...baseInput,
  profile: "sawyer" as const,
};

describe("classifyFiles", () => {
  test("detects Seascape-style frontend, runtime, docs, and devex surfaces", () => {
    expect(classifyFiles([
      "src/index.njk",
      "netlify/functions/submission-created.js",
      "docs/process/agent-safety-standard.md",
      "README.md",
    ])).toEqual({
      frontend: true,
      docs: true,
      devex: true,
      tests: false,
      runtime: true,
      deploy: false,
    });
  });
});

describe("decideNext", () => {
  test("routes planning prompt with no diff to /autoplan", () => {
    const decision = decideNext({ ...baseInput, prompt: "plan the next workflow router" });
    expect(decision.phase).toBe("plan");
    expect(decision.nextSkill).toBe("/autoplan");
    expect(decision.executeSupported).toBe(false);
  });

  test("blocks dirty protected branch instead of recommending mutation", () => {
    const decision = decideNext({
      ...baseInput,
      branch: "main",
      protectedBranch: true,
      dirty: true,
      changedFiles: ["src/index.ts"],
    });
    expect(decision.phase).toBe("blocked");
    expect(decision.nextSkill).toBeNull();
    expect(decision.stopsBefore).toContain("protected_branch_edit");
  });

  test("routes dirty backend branch without review proof to /review", () => {
    const decision = decideNext({
      ...baseInput,
      dirty: true,
      changedFiles: ["src/server.ts"],
      cleanReviewAtHead: false,
    });
    expect(decision.phase).toBe("review");
    expect(decision.nextSkill).toBe("/review");
  });

  test("routes user-visible UI changes to rendered design QA first", () => {
    const decision = decideNext({
      ...baseInput,
      dirty: true,
      changedFiles: ["src/pages/home.tsx", "styles/site.css"],
    });
    expect(decision.phase).toBe("qa");
    expect(decision.nextSkill).toBe("/design-review");
  });

  test("routes reviewed dirty branch to /ship", () => {
    const decision = decideNext({
      ...baseInput,
      dirty: true,
      changedFiles: ["src/server.ts"],
      cleanReviewAtHead: true,
    });
    expect(decision.phase).toBe("ship");
    expect(decision.nextSkill).toBe("/ship");
  });

  test("routes open PR to /land-and-deploy with merge/deploy hard stops", () => {
    const decision = decideNext({
      ...baseInput,
      pr: { state: "OPEN", number: 42, isDraft: false, checks: "green" },
    });
    expect(decision.phase).toBe("land");
    expect(decision.nextSkill).toBe("/land-and-deploy");
    expect(decision.stopsBefore).toContain("merge");
    expect(decision.stopsBefore).toContain("deploy");
  });

  test("routes merged Seascape runtime repo to post-merge runtime closeout", () => {
    const decision = decideNext({
      ...baseInput,
      cwd: "/Users/sawbeck/Projects/seascape-ops",
      repoName: "seascape-ops",
      pr: { state: "MERGED", number: 223, checks: "green" },
    });
    expect(decision.phase).toBe("runtime-closeout");
    expect(decision.nextSkill).toBe("post-merge-runtime-closeout");
  });

  test("routes developer-onboarding prompt to /devex-review", () => {
    const decision = decideNext({
      ...baseInput,
      prompt: "audit the developer onboarding and TTHW",
    });
    expect(decision.phase).toBe("docs-devex");
    expect(decision.nextSkill).toBe("/devex-review");
  });

  test("keeps low-signal resume handling profile-specific", () => {
    const defaultDecision = decideNext({
      ...baseInput,
      dirty: true,
      changedFiles: ["src/server.ts"],
      prompt: "continue this branch's work",
    });
    const sawyerDecision = decideNext({
      ...sawyerInput,
      dirty: true,
      changedFiles: ["src/server.ts"],
      prompt: "continue this branch's work",
    });

    expect(defaultDecision.nextSkill).toBe("/review");
    expect(sawyerDecision.nextSkill).toBe("/context-restore");
    expect(sawyerDecision.proofNeededAfter).toContain("handoff");
  });

  test("Sawyer profile routes merged canon repo closeout to proof-first closeout", () => {
    const decision = decideNext({
      ...sawyerInput,
      cwd: "/Users/sawbeck/Projects/seascape-hub",
      repoName: "seascape-hub",
      pr: { state: "MERGED", number: 306, checks: "green" },
    });

    expect(decision.phase).toBe("runtime-closeout");
    expect(decision.nextSkill).toBe("post-merge-runtime-closeout");
    expect(decision.why.join(" ")).toContain("Sawyer profile");
  });

  test("Sawyer profile routes reviewed developer-facing branch to live DX before ship", () => {
    const decision = decideNext({
      ...sawyerInput,
      dirty: true,
      cleanReviewAtHead: true,
      changedFiles: ["README.md", "bin/gstack-next"],
    });

    expect(decision.phase).toBe("docs-devex");
    expect(decision.nextSkill).toBe("/devex-review");
  });
});

describe("Sawyer replay pack", () => {
  const cases = [
    {
      name: "low-signal continue uses context recovery",
      input: { ...sawyerInput, dirty: true, changedFiles: ["src/server.ts"], prompt: "Continue" },
      skill: "/context-restore",
    },
    {
      name: "hot-thread handoff resumes context first",
      input: { ...sawyerInput, prompt: "resume the hot-thread recovery handoff" },
      skill: "/context-restore",
    },
    {
      name: "full review request uses autoplan",
      input: { ...sawyerInput, prompt: "plan-eng-review plan design review then ship it" },
      skill: "/autoplan",
    },
    {
      name: "bug asks for root cause first",
      input: { ...sawyerInput, prompt: "why is this broken in production?" },
      skill: "/investigate",
    },
    {
      name: "security ask routes to CSO",
      input: { ...sawyerInput, prompt: "is this webhook secure against replay attacks?" },
      skill: "/cso",
    },
    {
      name: "review status ask routes to readiness report",
      input: { ...sawyerInput, prompt: "did we plan-design-review this and are reviews current?" },
      skill: "/landing-report",
    },
    {
      name: "docs after ship routes to document release",
      input: { ...sawyerInput, prompt: "update docs after shipping this feature" },
      skill: "/document-release",
    },
    {
      name: "read-only QA request with no diff uses qa-only",
      input: { ...sawyerInput, prompt: "QA the staging site and just report bugs" },
      skill: "/qa-only",
    },
    {
      name: "frontend diff goes to rendered review",
      input: { ...sawyerInput, dirty: true, changedFiles: ["src/pages/home.tsx"] },
      skill: "/design-review",
    },
    {
      name: "backend diff without review proof goes to review",
      input: { ...sawyerInput, dirty: true, changedFiles: ["src/server.ts"] },
      skill: "/review",
    },
    {
      name: "backend diff with review proof goes to ship",
      input: { ...sawyerInput, dirty: true, changedFiles: ["src/server.ts"], cleanReviewAtHead: true },
      skill: "/ship",
    },
    {
      name: "open PR goes to land and deploy",
      input: { ...sawyerInput, pr: { state: "OPEN" as const, number: 42, isDraft: false, checks: "green" as const } },
      skill: "/land-and-deploy",
    },
    {
      name: "merged Seascape ops PR goes to runtime closeout",
      input: {
        ...sawyerInput,
        cwd: "/Users/sawbeck/Projects/seascape-ops",
        repoName: "seascape-ops",
        pr: { state: "MERGED" as const, number: 223, checks: "green" as const },
      },
      skill: "post-merge-runtime-closeout",
    },
  ];

  for (const replay of cases) {
    test(replay.name, () => {
      const decision = decideNext(replay.input);
      expect(decision.nextSkill).toBe(replay.skill);
      expect(decision.executeSupported).toBe(false);
      expect(decision.stopsBefore).toEqual(expect.arrayContaining(["push", "merge", "deploy"]));
    });
  }
});

describe("gstack-next CLI", () => {
  test("prints a dry-run receipt for a temp repo", () => {
    const dir = mkdtempSync(join(tmpdir(), "gstack-next-"));
    try {
      execFileSync("git", ["init", "-b", "main"], { cwd: dir });
      execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
      execFileSync("git", ["config", "user.name", "Test User"], { cwd: dir });
      writeFileSync(join(dir, "README.md"), "# Test\n");
      execFileSync("git", ["add", "README.md"], { cwd: dir });
      execFileSync("git", ["commit", "-m", "initial"], { cwd: dir });
      execFileSync("git", ["checkout", "-b", "codex/test"], { cwd: dir });
      mkdirSync(join(dir, "src"), { recursive: true });
      writeFileSync(join(dir, "src", "server.ts"), "export const ok = true;\n");

      const output = execFileSync(
        join(import.meta.dir, "..", "bin", "gstack-next"),
        ["--repo", dir, "--profile", "sawyer"],
        { encoding: "utf8" },
      );

      expect(output).toContain("GSTACK NEXT (dry-run)");
      expect(output).toContain("Profile: sawyer");
      expect(output).toContain("Phase: review");
      expect(output).toContain("Next skill: /review");
      expect(output).toContain("Execute mode: not supported yet");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("detects committed branch diffs when only origin/main exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "gstack-next-remote-base-"));
    try {
      execFileSync("git", ["init", "-b", "main"], { cwd: dir });
      execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
      execFileSync("git", ["config", "user.name", "Test User"], { cwd: dir });
      writeFileSync(join(dir, "README.md"), "# Test\n");
      execFileSync("git", ["add", "README.md"], { cwd: dir });
      execFileSync("git", ["commit", "-m", "initial"], { cwd: dir });
      const baseSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
      execFileSync("git", ["checkout", "-b", "codex/test"], { cwd: dir });
      execFileSync("git", ["update-ref", "refs/remotes/origin/main", baseSha], { cwd: dir });
      execFileSync("git", ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"], { cwd: dir });
      execFileSync("git", ["branch", "-D", "main"], { cwd: dir });
      mkdirSync(join(dir, "src"), { recursive: true });
      writeFileSync(join(dir, "src", "server.ts"), "export const ok = true;\n");
      execFileSync("git", ["add", "src/server.ts"], { cwd: dir });
      execFileSync("git", ["commit", "-m", "add server"], { cwd: dir });

      const output = execFileSync(
        join(import.meta.dir, "..", "bin", "gstack-next"),
        ["--repo", dir, "--profile", "sawyer"],
        { encoding: "utf8" },
      );

      expect(output).toContain("Changed files: 1");
      expect(output).toContain("Phase: review");
      expect(output).toContain("Next skill: /review");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
