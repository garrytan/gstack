import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  checkWorkingTreeClean,
  findMergeCandidateBranches,
  findUnmergedLocalFeatBranches,
  findUnshippedFeatBranches,
  verifyNoUnmergedFeatBranches,
} from "../cli";
import { activeOwnedBranches, writeActiveRunRecord } from "../active-runs";

describe("checkWorkingTreeClean", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "startup-clean-"));
    spawnSync("git", ["init", "--initial-branch=main"], { cwd: tempDir });
    // Fallback for git < 2.28 that ignores --initial-branch.
    spawnSync("git", ["checkout", "-B", "main"], { cwd: tempDir });
    spawnSync("git", ["config", "user.email", "test@test.com"], {
      cwd: tempDir,
    });
    spawnSync("git", ["config", "user.name", "Test"], { cwd: tempDir });
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("clean repo → { clean: true, dirty: [] }", () => {
    fs.writeFileSync(path.join(tempDir, "README.md"), "init");
    spawnSync("git", ["add", "."], { cwd: tempDir });
    spawnSync("git", ["commit", "-m", "init"], { cwd: tempDir });

    expect(checkWorkingTreeClean(tempDir)).toEqual({ clean: true, dirty: [] });
  });

  it("repo with a modified tracked file → { clean: false }, dirty array contains the status line", () => {
    fs.writeFileSync(path.join(tempDir, "README.md"), "init");
    spawnSync("git", ["add", "."], { cwd: tempDir });
    spawnSync("git", ["commit", "-m", "init"], { cwd: tempDir });

    fs.writeFileSync(path.join(tempDir, "README.md"), "mod");

    const result = checkWorkingTreeClean(tempDir);
    expect(result.clean).toBe(false);
    expect(result.dirty.length).toBeGreaterThan(0);
    expect(result.dirty[0]).toMatch(/M README\.md/);
  });

  it("repo with ONLY an untracked file (not git added) → { clean: false }", () => {
    fs.writeFileSync(path.join(tempDir, "README.md"), "init");
    spawnSync("git", ["add", "."], { cwd: tempDir });
    spawnSync("git", ["commit", "-m", "init"], { cwd: tempDir });

    fs.writeFileSync(path.join(tempDir, "untracked.ts"), "untracked");

    const result = checkWorkingTreeClean(tempDir);
    expect(result.clean).toBe(false);
    expect(result.dirty).toEqual(["?? untracked.ts"]);
  });

  it("repo with a staged (git add) file → { clean: false }", () => {
    fs.writeFileSync(path.join(tempDir, "README.md"), "init");
    spawnSync("git", ["add", "."], { cwd: tempDir });
    spawnSync("git", ["commit", "-m", "init"], { cwd: tempDir });

    fs.writeFileSync(path.join(tempDir, "staged.ts"), "staged");
    spawnSync("git", ["add", "staged.ts"], { cwd: tempDir });

    const result = checkWorkingTreeClean(tempDir);
    expect(result.clean).toBe(false);
    expect(result.dirty).toHaveLength(1);
    expect(result.dirty[0]).toMatch(/A\s+staged\.ts/);
  });
});

describe("findUnshippedFeatBranches", () => {
  let mainDir: string;
  let bareDir: string;

  beforeEach(() => {
    mainDir = fs.mkdtempSync(path.join(os.tmpdir(), "startup-main-"));
    bareDir = fs.mkdtempSync(path.join(os.tmpdir(), "startup-bare-"));
    spawnSync("git", ["init", "--initial-branch=main"], { cwd: mainDir });
    // Fallback for git < 2.28 that ignores --initial-branch.
    spawnSync("git", ["checkout", "-B", "main"], { cwd: mainDir });
    spawnSync("git", ["config", "user.email", "test@test.com"], {
      cwd: mainDir,
    });
    spawnSync("git", ["config", "user.name", "Test"], { cwd: mainDir });
    spawnSync("git", ["init", "--bare", "--initial-branch=main"], {
      cwd: bareDir,
    });
    // Fallback for git < 2.28 that ignores --initial-branch in bare repos.
    spawnSync("git", ["symbolic-ref", "HEAD", "refs/heads/main"], {
      cwd: bareDir,
    });
    spawnSync("git", ["remote", "add", "origin", bareDir], { cwd: mainDir });
    // make a commit so main exists
    fs.writeFileSync(path.join(mainDir, "README.md"), "init");
    spawnSync("git", ["add", "."], { cwd: mainDir });
    spawnSync("git", ["commit", "-m", "init"], { cwd: mainDir });
    spawnSync("git", ["push", "-u", "origin", "main"], { cwd: mainDir });
  });

  afterEach(() => {
    fs.rmSync(mainDir, { recursive: true, force: true });
    fs.rmSync(bareDir, { recursive: true, force: true });
  });

  it('remote has origin/feat/a (not merged to main) → returns ["feat/a"]', () => {
    spawnSync("git", ["checkout", "-b", "feat/a"], { cwd: mainDir });
    fs.writeFileSync(path.join(mainDir, "feat-a.ts"), "feat a");
    spawnSync("git", ["add", "."], { cwd: mainDir });
    spawnSync("git", ["commit", "-m", "feat a"], { cwd: mainDir });
    spawnSync("git", ["push", "origin", "feat/a"], { cwd: mainDir });
    spawnSync("git", ["checkout", "main"], { cwd: mainDir });

    const result = findUnshippedFeatBranches(mainDir, "main");
    expect(result).toEqual(["feat/a"]);
  });

  it("remote branch discovery uses origin/master when origin/main is absent", () => {
    spawnSync("git", ["checkout", "-B", "master"], { cwd: mainDir });
    spawnSync("git", ["push", "-u", "origin", "master"], { cwd: mainDir });
    spawnSync("git", ["symbolic-ref", "HEAD", "refs/heads/master"], {
      cwd: bareDir,
    });
    spawnSync("git", ["push", "origin", "--delete", "main"], { cwd: mainDir });

    spawnSync("git", ["checkout", "-b", "feat/on-master"], { cwd: mainDir });
    fs.writeFileSync(path.join(mainDir, "on-master.ts"), "feat on master");
    spawnSync("git", ["add", "."], { cwd: mainDir });
    spawnSync("git", ["commit", "-m", "feat on master"], { cwd: mainDir });
    spawnSync("git", ["push", "origin", "feat/on-master"], { cwd: mainDir });
    spawnSync("git", ["checkout", "master"], { cwd: mainDir });

    const result = findUnshippedFeatBranches(mainDir, "master");
    expect(result).toEqual(["feat/on-master"]);
  });

  it("remote has origin/feat/b (merged to main) → returns []", () => {
    spawnSync("git", ["checkout", "-b", "feat/b"], { cwd: mainDir });
    fs.writeFileSync(path.join(mainDir, "feat-b.ts"), "feat b");
    spawnSync("git", ["add", "."], { cwd: mainDir });
    spawnSync("git", ["commit", "-m", "feat b"], { cwd: mainDir });
    spawnSync("git", ["push", "origin", "feat/b"], { cwd: mainDir });
    spawnSync("git", ["checkout", "main"], { cwd: mainDir });
    spawnSync("git", ["merge", "--no-ff", "feat/b", "-m", "merge feat/b"], {
      cwd: mainDir,
    });
    spawnSync("git", ["push", "origin", "main"], { cwd: mainDir });

    const result = findUnshippedFeatBranches(mainDir, "main");
    expect(result).toEqual([]);
  });

  it("current branch is feat/a (even if unmerged) → excluded from results (returns [])", () => {
    spawnSync("git", ["checkout", "-b", "feat/a"], { cwd: mainDir });
    fs.writeFileSync(path.join(mainDir, "feat-a.ts"), "feat a");
    spawnSync("git", ["add", "."], { cwd: mainDir });
    spawnSync("git", ["commit", "-m", "feat a"], { cwd: mainDir });
    spawnSync("git", ["push", "origin", "feat/a"], { cwd: mainDir });

    // We stay on feat/a
    const result = findUnshippedFeatBranches(mainDir, "feat/a");
    expect(result).toEqual([]);
  });

  it("no feat/* branches on origin → returns []", () => {
    const result = findUnshippedFeatBranches(mainDir, "main");
    expect(result).toEqual([]);
  });

  it("local has unmerged feat branch not pushed to origin → returns local branch", () => {
    spawnSync("git", ["checkout", "-b", "feat/local-only"], { cwd: mainDir });
    fs.writeFileSync(path.join(mainDir, "local-only.ts"), "local");
    spawnSync("git", ["add", "."], { cwd: mainDir });
    spawnSync("git", ["commit", "-m", "feat local only"], { cwd: mainDir });
    spawnSync("git", ["checkout", "main"], { cwd: mainDir });

    const result = findUnmergedLocalFeatBranches(mainDir, "main");
    expect(result).toEqual(["feat/local-only"]);
  });

  it("merge candidates include de-duped local and remote unmerged feat branches", () => {
    spawnSync("git", ["checkout", "-b", "feat/remote-only"], { cwd: mainDir });
    fs.writeFileSync(path.join(mainDir, "remote-only.ts"), "remote");
    spawnSync("git", ["add", "."], { cwd: mainDir });
    spawnSync("git", ["commit", "-m", "feat remote only"], { cwd: mainDir });
    spawnSync("git", ["push", "origin", "feat/remote-only"], { cwd: mainDir });
    spawnSync("git", ["checkout", "main"], { cwd: mainDir });
    spawnSync("git", ["branch", "-D", "feat/remote-only"], { cwd: mainDir });

    spawnSync("git", ["checkout", "-b", "feat/local-only"], { cwd: mainDir });
    fs.writeFileSync(path.join(mainDir, "local-only.ts"), "local");
    spawnSync("git", ["add", "."], { cwd: mainDir });
    spawnSync("git", ["commit", "-m", "feat local only"], { cwd: mainDir });
    spawnSync("git", ["checkout", "main"], { cwd: mainDir });

    spawnSync("git", ["checkout", "-b", "feat/both"], { cwd: mainDir });
    fs.writeFileSync(path.join(mainDir, "both.ts"), "both");
    spawnSync("git", ["add", "."], { cwd: mainDir });
    spawnSync("git", ["commit", "-m", "feat both"], { cwd: mainDir });
    spawnSync("git", ["push", "origin", "feat/both"], { cwd: mainDir });
    spawnSync("git", ["checkout", "main"], { cwd: mainDir });

    const result = findMergeCandidateBranches(mainDir, "main");
    expect(result.map((b) => b.name)).toEqual([
      "feat/both",
      "feat/local-only",
      "feat/remote-only",
    ]);
    expect(result.find((b) => b.name === "feat/both")?.hasLocal).toBe(true);
    expect(result.find((b) => b.name === "feat/both")?.hasRemote).toBe(true);
    expect(result.find((b) => b.name === "feat/local-only")?.hasLocal).toBe(
      true,
    );
    expect(result.find((b) => b.name === "feat/local-only")?.hasRemote).toBe(
      false,
    );
    expect(result.find((b) => b.name === "feat/remote-only")?.hasLocal).toBe(
      false,
    );
    expect(result.find((b) => b.name === "feat/remote-only")?.hasRemote).toBe(
      true,
    );
  });

  it("merge candidates can include the current unmerged feat branch for explicit merge mode", () => {
    spawnSync("git", ["checkout", "-b", "feat/current"], { cwd: mainDir });
    fs.writeFileSync(path.join(mainDir, "current.ts"), "current");
    spawnSync("git", ["add", "."], { cwd: mainDir });
    spawnSync("git", ["commit", "-m", "feat current"], { cwd: mainDir });
    spawnSync("git", ["push", "origin", "feat/current"], { cwd: mainDir });

    const startupSweepResult = findMergeCandidateBranches(
      mainDir,
      "feat/current",
    );
    expect(startupSweepResult.map((b) => b.name)).not.toContain("feat/current");

    const mergeModeResult = findMergeCandidateBranches(
      mainDir,
      "feat/current",
      {
        includeCurrent: true,
      },
    );
    expect(mergeModeResult).toContainEqual({
      name: "feat/current",
      hasLocal: true,
      hasRemote: true,
    });
  });

  it("merge candidate discovery can skip active-run branches", () => {
    spawnSync("git", ["checkout", "-b", "feat/active"], { cwd: mainDir });
    fs.writeFileSync(path.join(mainDir, "active.ts"), "active");
    spawnSync("git", ["add", "."], { cwd: mainDir });
    spawnSync("git", ["commit", "-m", "feat active"], { cwd: mainDir });
    spawnSync("git", ["push", "origin", "feat/active"], { cwd: mainDir });
    spawnSync("git", ["checkout", "main"], { cwd: mainDir });

    const ignored = new Set(["feat/active"]);
    expect(
      findUnshippedFeatBranches(mainDir, "main", { ignoreBranches: ignored }),
    ).toEqual([]);
    expect(
      findMergeCandidateBranches(mainDir, "main", {
        includeCurrent: true,
        ignoreBranches: ignored,
      }),
    ).toEqual([]);
  });

  it("merge candidate discovery skips provisional active-run bootstrap branches", () => {
    spawnSync("git", ["checkout", "-b", "feat/repo-run-bootstrap"], {
      cwd: mainDir,
    });
    fs.writeFileSync(path.join(mainDir, "bootstrap.ts"), "bootstrap");
    spawnSync("git", ["add", "."], { cwd: mainDir });
    spawnSync("git", ["commit", "-m", "feat bootstrap"], { cwd: mainDir });
    spawnSync("git", ["push", "origin", "feat/repo-run-bootstrap"], {
      cwd: mainDir,
    });
    spawnSync("git", ["checkout", "main"], { cwd: mainDir });

    const registryDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "startup-provisional-"),
    );
    try {
      writeActiveRunRecord(registryDir, {
        runId: "repo-run",
        stateSlug: "build-repo-run",
        repoPath: mainDir,
        baseProjectRoot: mainDir,
        planFile: "/plans/source.md",
        branchPrefix: "repo-run",
        pid: process.pid,
        status: "running",
        startedAt: "2026-05-08T00:00:00.000Z",
        lastUpdatedAt: "2026-05-08T00:00:00.000Z",
        branches: ["feat/repo-run-bootstrap"],
      });

      const ignored = activeOwnedBranches(registryDir, {
        projectRoot: mainDir,
        baseProjectRoot: mainDir,
      });
      expect(ignored).toEqual(new Set(["feat/repo-run-bootstrap"]));
      expect(
        findUnshippedFeatBranches(mainDir, "main", {
          ignoreBranches: ignored,
        }),
      ).toEqual([]);
      expect(
        findMergeCandidateBranches(mainDir, "main", {
          includeCurrent: true,
          ignoreBranches: ignored,
        }),
      ).toEqual([]);
    } finally {
      fs.rmSync(registryDir, { recursive: true, force: true });
    }
  });

  it("active-run skips from another repo do not hide current repo branches", () => {
    spawnSync("git", ["checkout", "-b", "feat/active"], { cwd: mainDir });
    fs.writeFileSync(path.join(mainDir, "active.ts"), "active");
    spawnSync("git", ["add", "."], { cwd: mainDir });
    spawnSync("git", ["commit", "-m", "feat active"], { cwd: mainDir });
    spawnSync("git", ["push", "origin", "feat/active"], { cwd: mainDir });
    spawnSync("git", ["checkout", "main"], { cwd: mainDir });

    const registryDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "startup-active-runs-"),
    );
    try {
      writeActiveRunRecord(registryDir, {
        runId: "other-repo-run",
        stateSlug: "build-other-repo-run",
        repoPath: path.join(os.tmpdir(), "other-repo"),
        planFile: "/plans/other.md",
        pid: process.pid,
        status: "running",
        startedAt: "2026-05-08T00:00:00.000Z",
        lastUpdatedAt: "2026-05-08T00:00:00.000Z",
        branches: ["feat/active"],
      });

      const ignoredForCurrentRepo = activeOwnedBranches(registryDir, {
        projectRoot: mainDir,
      });
      expect(ignoredForCurrentRepo).toEqual(new Set());
      expect(
        findUnshippedFeatBranches(mainDir, "main", {
          ignoreBranches: ignoredForCurrentRepo,
        }),
      ).toEqual(["feat/active"]);
      expect(
        findMergeCandidateBranches(mainDir, "main", {
          includeCurrent: true,
          ignoreBranches: ignoredForCurrentRepo,
        }).map((branch) => branch.name),
      ).toEqual(["feat/active"]);
      expect(
        verifyNoUnmergedFeatBranches(mainDir, "main", {
          ignoreBranches: ignoredForCurrentRepo,
        }).ok,
      ).toBe(false);
    } finally {
      fs.rmSync(registryDir, { recursive: true, force: true });
    }
  });

  it("strict final exam check fails closed when fetch cannot verify remote branches", () => {
    spawnSync(
      "git",
      ["remote", "set-url", "origin", path.join(bareDir, "missing.git")],
      { cwd: mainDir },
    );

    const result = verifyNoUnmergedFeatBranches(mainDir, "main");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("git fetch failed");
  });

  it("strict final exam includes the current unmerged feat branch", () => {
    spawnSync("git", ["checkout", "-b", "feat/current"], { cwd: mainDir });
    fs.writeFileSync(path.join(mainDir, "current.ts"), "current");
    spawnSync("git", ["add", "."], { cwd: mainDir });
    spawnSync("git", ["commit", "-m", "feat current"], { cwd: mainDir });
    spawnSync("git", ["push", "origin", "feat/current"], { cwd: mainDir });

    const result = verifyNoUnmergedFeatBranches(mainDir, "feat/current");
    expect(result.ok).toBe(false);
    expect(result.branches).toContain("origin/feat/current");
    expect(result.branches).toContain("feat/current");
  });

  it("strict final exam uses origin/master when origin/main is absent", () => {
    spawnSync("git", ["branch", "-m", "main", "master"], { cwd: mainDir });
    spawnSync("git", ["push", "-u", "origin", "master"], { cwd: mainDir });
    spawnSync("git", ["symbolic-ref", "HEAD", "refs/heads/master"], {
      cwd: bareDir,
    });
    spawnSync("git", ["push", "origin", ":main"], { cwd: mainDir });
    spawnSync("git", ["fetch", "--prune", "origin"], { cwd: mainDir });

    const result = verifyNoUnmergedFeatBranches(mainDir, "master");
    expect(result).toEqual({ ok: true, branches: [] });
  });

  it("strict final exam can ignore known shipped local squash branches", () => {
    spawnSync("git", ["checkout", "-b", "feat/squashed"], { cwd: mainDir });
    fs.writeFileSync(path.join(mainDir, "squashed.ts"), "squashed");
    spawnSync("git", ["add", "."], { cwd: mainDir });
    spawnSync("git", ["commit", "-m", "feat squashed"], { cwd: mainDir });
    spawnSync("git", ["checkout", "main"], { cwd: mainDir });

    const blocked = verifyNoUnmergedFeatBranches(mainDir, "main");
    expect(blocked.ok).toBe(false);
    expect(blocked.branches).toContain("feat/squashed");

    const ignored = verifyNoUnmergedFeatBranches(mainDir, "main", {
      ignoreLocalBranches: ["feat/squashed"],
    });
    expect(ignored).toEqual({ ok: true, branches: [] });
  });

  it("strict final exam ignores active branches owned by other runs", () => {
    spawnSync("git", ["checkout", "-b", "feat/active"], { cwd: mainDir });
    fs.writeFileSync(path.join(mainDir, "active.ts"), "active");
    spawnSync("git", ["add", "."], { cwd: mainDir });
    spawnSync("git", ["commit", "-m", "feat active"], { cwd: mainDir });
    spawnSync("git", ["push", "origin", "feat/active"], { cwd: mainDir });
    spawnSync("git", ["checkout", "main"], { cwd: mainDir });

    const blocked = verifyNoUnmergedFeatBranches(mainDir, "main");
    expect(blocked.ok).toBe(false);
    expect(blocked.branches).toContain("origin/feat/active");

    const ignored = verifyNoUnmergedFeatBranches(mainDir, "main", {
      ignoreBranches: new Set(["feat/active"]),
    });
    expect(ignored).toEqual({ ok: true, branches: [] });
  });
});
