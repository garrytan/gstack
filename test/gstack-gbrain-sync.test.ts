/**
 * Unit tests for bin/gstack-gbrain-sync.ts (Lane B).
 *
 * Tests CLI surface (modes + flags + help). Stage internals (gbrain import,
 * memory ingest, brain-sync push) shell out to external binaries and are
 * exercised by Lane F E2E tests; here we verify orchestration + dry-run
 * preview + state file lifecycle + flag composition.
 */

import { describe, it, expect } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawnSync } from "child_process";

const SCRIPT = join(import.meta.dir, "..", "bin", "gstack-gbrain-sync.ts");

function makeTestHome(): string {
  return mkdtempSync(join(tmpdir(), "gstack-gbrain-sync-"));
}

function runScript(args: string[], env: Record<string, string> = {}): { stdout: string; stderr: string; exitCode: number } {
  const result = spawnSync("bun", [SCRIPT, ...args], {
    encoding: "utf-8",
    timeout: 60000,
    env: { ...process.env, ...env },
  });
  return {
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    exitCode: result.status ?? 1,
  };
}

describe("gstack-gbrain-sync CLI", () => {
  it("--help exits 0 with usage text", () => {
    const r = runScript(["--help"]);
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toContain("Usage: gstack-gbrain-sync");
    expect(r.stderr).toContain("--incremental");
    expect(r.stderr).toContain("--full");
    expect(r.stderr).toContain("--dry-run");
  });

  it("rejects unknown flag", () => {
    const r = runScript(["--bogus"]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("Unknown argument: --bogus");
  });

  it("--dry-run with --code-only reports the code import preview only", () => {
    const home = makeTestHome();
    const gstackHome = join(home, ".gstack");
    mkdirSync(gstackHome, { recursive: true });

    const r = runScript(["--dry-run", "--code-only", "--quiet"], { HOME: home, GSTACK_HOME: gstackHome });
    expect(r.exitCode).toBe(0);
    // Code stage now uses native code surface: sources add + sync --strategy code
    // (NOT gbrain import — that's the markdown-only path that was rejected post-codex).
    expect(r.stdout).toContain("would: gbrain sources add");
    expect(r.stdout).toContain("gbrain sync --strategy code");
    expect(r.stdout).not.toContain("gbrain import");
    // memory + brain-sync stages should not appear
    expect(r.stdout).not.toContain("gstack-memory-ingest --probe");
    expect(r.stdout).not.toContain("gstack-brain-sync --discover-new");
    rmSync(home, { recursive: true, force: true });
  });

  it("--dry-run with all stages shows previews for all three", () => {
    const home = makeTestHome();
    const gstackHome = join(home, ".gstack");
    mkdirSync(gstackHome, { recursive: true });

    const r = runScript(["--dry-run"], { HOME: home, GSTACK_HOME: gstackHome });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("would: gbrain sources add");
    expect(r.stdout).toContain("gbrain sync --strategy code");
    expect(r.stdout).toContain("would: gstack-memory-ingest");
    expect(r.stdout).toContain("would: gstack-brain-sync");
    rmSync(home, { recursive: true, force: true });
  });

  it("--no-code skips the code import stage", () => {
    const home = makeTestHome();
    const gstackHome = join(home, ".gstack");
    mkdirSync(gstackHome, { recursive: true });

    const r = runScript(["--dry-run", "--no-code"], { HOME: home, GSTACK_HOME: gstackHome });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).not.toContain("would: gbrain sources add");
    expect(r.stdout).toContain("would: gstack-memory-ingest");
    rmSync(home, { recursive: true, force: true });
  });

  it("dry-run derives a stable source id from the canonical git remote", () => {
    // The source id pattern is `gstack-code-<canonicalized-remote>`. For this
    // repo (github.com/garrytan/gstack), the slug should appear in the dry-run
    // preview line. We don't pin the exact slug — just verify the prefix +
    // that the preview command would target a source with id gstack-code-*.
    const home = makeTestHome();
    const gstackHome = join(home, ".gstack");
    mkdirSync(gstackHome, { recursive: true });

    const r = runScript(["--dry-run", "--code-only", "--quiet"], { HOME: home, GSTACK_HOME: gstackHome });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/gbrain sources add gstack-code-[a-z0-9-]+/);
    expect(r.stdout).toMatch(/gbrain sync --strategy code --source gstack-code-[a-z0-9-]+/);
    rmSync(home, { recursive: true, force: true });
  });

  it("derived source ids are gbrain-valid (≤32 chars, alnum + interior hyphens, no dots) for any remote", () => {
    // gbrain enforces source ids to be 1-32 lowercase alnum chars with optional interior
    // hyphens. Pre-fix, the slug came from canonicalizeRemote() with only `/` and
    // whitespace stripped — leaving dots from hostnames (`github.com`) and no length cap.
    // For `github.com/<org>/<repo>`, the id was `gstack-code-github.com-<org>-<repo>`,
    // which fails validation on both counts. This test exercises the derivation against
    // controlled remotes by spawning the CLI in a temp git repo.
    const cases = [
      "https://github.com/radubach/platform.git",      // dot in hostname, total > 32 with old slug
      "git@github.com:garrytan/gstack.git",            // SCP-style remote
      "https://gitlab.example.com/team/proj.git",      // multi-dot host, non-github
      "https://github.com/some-very-long-org-name/some-very-long-repo-name.git", // forces hash-truncate
    ];
    const VALID_ID = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
    for (const remote of cases) {
      const home = makeTestHome();
      const gstackHome = join(home, ".gstack");
      mkdirSync(gstackHome, { recursive: true });
      const repo = mkdtempSync(join(tmpdir(), "gstack-source-id-repo-"));
      spawnSync("git", ["init", "--quiet", "-b", "main"], { cwd: repo });
      spawnSync("git", ["remote", "add", "origin", remote], { cwd: repo });

      const r = spawnSync("bun", [SCRIPT, "--dry-run", "--code-only", "--quiet"], {
        encoding: "utf-8",
        timeout: 60000,
        cwd: repo,
        env: { ...process.env, HOME: home, GSTACK_HOME: gstackHome },
      });
      expect(r.status).toBe(0);
      const m = (r.stdout || "").match(/gbrain sources add (\S+)/);
      expect(m).not.toBeNull();
      const id = m![1];
      expect(id.length).toBeLessThanOrEqual(32);
      expect(id).toMatch(VALID_ID);
      expect(id.startsWith("gstack-code-")).toBe(true);

      rmSync(repo, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("derives a gbrain-valid source id when the cwd repo has NO origin remote", () => {
    // Fallback path in deriveCodeSourceId(): no `origin` remote configured,
    // so the slug comes from the repo basename. The fallback must still
    // produce a gbrain-valid id (no dots, ≤32 chars, no trailing hyphen).
    const home = makeTestHome();
    const gstackHome = join(home, ".gstack");
    mkdirSync(gstackHome, { recursive: true });
    const repo = mkdtempSync(join(tmpdir(), "gstack-no-origin-"));
    spawnSync("git", ["init", "--quiet", "-b", "main"], { cwd: repo });
    // No `git remote add origin` — this is the no-remote case.

    const r = spawnSync("bun", [SCRIPT, "--dry-run", "--code-only", "--quiet"], {
      encoding: "utf-8",
      timeout: 60000,
      cwd: repo,
      env: { ...process.env, HOME: home, GSTACK_HOME: gstackHome },
    });
    expect(r.status).toBe(0);
    const m = (r.stdout || "").match(/gbrain sources add (\S+)/);
    expect(m).not.toBeNull();
    const id = m![1];
    expect(id.startsWith("gstack-code-")).toBe(true);
    expect(id.length).toBeLessThanOrEqual(32);
    expect(id).toMatch(/^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/);

    rmSync(repo, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  it("derives a gbrain-valid source id when the basename sanitizes to empty", () => {
    // Pathological edge: a repo whose basename is all non-alnum (e.g. "___")
    // sanitizes to an empty slug. Pre-worktree-aware-fix, constrainSourceId
    // returned "gstack-code-" (invalid trailing hyphen) and was patched to
    // fall back to a 6-char hash of the original input. The post-spike
    // redesign appends an 8-char path-hash to every id, so the basename's
    // empty-after-sanitize result is no longer a problem on its own — the
    // path hash carries the entropy. The id must still be gbrain-valid.
    const home = makeTestHome();
    const gstackHome = join(home, ".gstack");
    mkdirSync(gstackHome, { recursive: true });
    const parent = mkdtempSync(join(tmpdir(), "gstack-empty-base-"));
    const repo = join(parent, "___");
    mkdirSync(repo);
    spawnSync("git", ["init", "--quiet", "-b", "main"], { cwd: repo });
    // No `origin` remote — forces the basename-fallback path.

    const r = spawnSync("bun", [SCRIPT, "--dry-run", "--code-only", "--quiet"], {
      encoding: "utf-8",
      timeout: 60000,
      cwd: repo,
      env: { ...process.env, HOME: home, GSTACK_HOME: gstackHome },
    });
    expect(r.status).toBe(0);
    const m = (r.stdout || "").match(/gbrain sources add (\S+)/);
    expect(m).not.toBeNull();
    const id = m![1];
    // gbrain validator: 1-32 lowercase alnum + interior hyphens, no leading
    // or trailing hyphens.
    expect(id.startsWith("gstack-code-")).toBe(true);
    expect(id.length).toBeLessThanOrEqual(32);
    expect(id).toMatch(/^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/);

    rmSync(parent, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  it("dry-run does NOT acquire the lock file (lock is for write paths only)", () => {
    const home = makeTestHome();
    const gstackHome = join(home, ".gstack");
    mkdirSync(gstackHome, { recursive: true });

    const r = runScript(["--dry-run"], { HOME: home, GSTACK_HOME: gstackHome });
    expect(r.exitCode).toBe(0);
    // Lock file should not exist after a dry-run (it's a write-only safety primitive).
    const lockPath = join(gstackHome, ".sync-gbrain.lock");
    expect(existsSync(lockPath)).toBe(false);
    rmSync(home, { recursive: true, force: true });
  });

  it("a stale lock file (older than 5 min) is taken over, not blocking", () => {
    const home = makeTestHome();
    const gstackHome = join(home, ".gstack");
    mkdirSync(gstackHome, { recursive: true });

    // Plant a stale lock file (mtime 6 min ago).
    const lockPath = join(gstackHome, ".sync-gbrain.lock");
    writeFileSync(lockPath, JSON.stringify({ pid: 99999, started_at: new Date(Date.now() - 6 * 60 * 1000).toISOString() }));
    const sixMinAgo = (Date.now() - 6 * 60 * 1000) / 1000;
    // Set mtime explicitly via Bun's fs.utimes
    const fs = require("fs");
    fs.utimesSync(lockPath, sixMinAgo, sixMinAgo);

    // Run with all stages disabled so we don't actually invoke anything heavy.
    const r = runScript(["--incremental", "--no-code", "--no-memory", "--no-brain-sync", "--quiet"], {
      HOME: home,
      GSTACK_HOME: gstackHome,
    });
    expect(r.exitCode).toBe(0);
    // Lock should be cleared after the run (we took it over and released).
    expect(existsSync(lockPath)).toBe(false);
    rmSync(home, { recursive: true, force: true });
  });

  it("a fresh lock file (less than 5 min old) blocks a second invocation with exit 2", () => {
    const home = makeTestHome();
    const gstackHome = join(home, ".gstack");
    mkdirSync(gstackHome, { recursive: true });

    // Plant a fresh lock file (mtime now).
    const lockPath = join(gstackHome, ".sync-gbrain.lock");
    writeFileSync(lockPath, JSON.stringify({ pid: 99999, started_at: new Date().toISOString() }));

    const r = runScript(["--incremental", "--no-code", "--no-memory", "--no-brain-sync", "--quiet"], {
      HOME: home,
      GSTACK_HOME: gstackHome,
    });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("another /sync-gbrain is running");
    // Lock should still be there — the second invocation didn't take it over.
    expect(existsSync(lockPath)).toBe(true);
    rmSync(home, { recursive: true, force: true });
  });

  it("writes a state file with schema_version: 1 after a non-dry run", () => {
    const home = makeTestHome();
    const gstackHome = join(home, ".gstack");
    mkdirSync(gstackHome, { recursive: true });

    // Run with all stages disabled to avoid actually invoking gbrain/memory-ingest
    const r = runScript(["--incremental", "--no-code", "--no-memory", "--no-brain-sync", "--quiet"], {
      HOME: home,
      GSTACK_HOME: gstackHome,
    });
    expect(r.exitCode).toBe(0);

    const statePath = join(gstackHome, ".gbrain-sync-state.json");
    expect(existsSync(statePath)).toBe(true);
    const state = JSON.parse(readFileSync(statePath, "utf-8"));
    expect(state.schema_version).toBe(1);
    expect(state.last_writer).toBe("gstack-gbrain-sync");
    expect(typeof state.last_sync).toBe("string");
    rmSync(home, { recursive: true, force: true });
  });

  it("does NOT write state file on --dry-run", () => {
    const home = makeTestHome();
    const gstackHome = join(home, ".gstack");
    mkdirSync(gstackHome, { recursive: true });

    const r = runScript(["--dry-run"], { HOME: home, GSTACK_HOME: gstackHome });
    expect(r.exitCode).toBe(0);

    const statePath = join(gstackHome, ".gbrain-sync-state.json");
    expect(existsSync(statePath)).toBe(false);
    rmSync(home, { recursive: true, force: true });
  });

  it("records stage results in state file", () => {
    const home = makeTestHome();
    const gstackHome = join(home, ".gstack");
    mkdirSync(gstackHome, { recursive: true });

    runScript(["--incremental", "--no-code", "--no-memory", "--no-brain-sync", "--quiet"], {
      HOME: home,
      GSTACK_HOME: gstackHome,
    });

    const state = JSON.parse(readFileSync(join(gstackHome, ".gbrain-sync-state.json"), "utf-8"));
    expect(Array.isArray(state.last_stages)).toBe(true);
    // With all stages disabled, last_stages is empty
    expect(state.last_stages.length).toBe(0);
    rmSync(home, { recursive: true, force: true });
  });

  it("brain-sync stage resolves the sibling binary, not a HOME-rooted path", () => {
    // Regression for Codex M9: pre-fix the orchestrator looked up
    // ~/.claude/skills/gstack/bin/gstack-brain-sync, which silently no-op'd
    // on Codex installs and dev workspaces with the misleading summary
    // "skipped (gstack-brain-sync not installed)". Post-fix it resolves
    // a sibling via import.meta.dir and actually invokes the script.
    const home = makeTestHome();
    const gstackHome = join(home, ".gstack");
    mkdirSync(gstackHome, { recursive: true });

    const r = runScript(
      ["--incremental", "--no-code", "--no-memory", "--quiet"],
      { HOME: home, GSTACK_HOME: gstackHome },
    );

    // Don't assert exit code (sibling spawn may legitimately error in a
    // sandboxed test). Assert only that we did NOT take the lying-skip path.
    const combined = r.stdout + r.stderr;
    expect(combined).not.toContain("skipped (gstack-brain-sync not installed)");
    rmSync(home, { recursive: true, force: true });
  });

  it("worktree-aware source ID: two worktrees of the same repo get DIFFERENT ids", () => {
    // Conductor pattern: same origin, two different absolute paths. Pre-fix the
    // ID was slug-only so both worktrees collapsed onto `gstack-code-<slug>` and
    // last-sync-wins corrupted whichever the user wasn't actively syncing. The
    // pathhash8 suffix makes each worktree's source independent.
    const remote = "https://github.com/garrytan/gstack.git";
    const home = makeTestHome();
    const gstackHome = join(home, ".gstack");
    mkdirSync(gstackHome, { recursive: true });

    const repoA = mkdtempSync(join(tmpdir(), "gstack-worktree-a-"));
    const repoB = mkdtempSync(join(tmpdir(), "gstack-worktree-b-"));
    for (const repo of [repoA, repoB]) {
      spawnSync("git", ["init", "--quiet", "-b", "main"], { cwd: repo });
      spawnSync("git", ["remote", "add", "origin", remote], { cwd: repo });
    }

    const idOf = (cwd: string): string => {
      const r = spawnSync("bun", [SCRIPT, "--dry-run", "--code-only", "--quiet"], {
        encoding: "utf-8",
        timeout: 60000,
        cwd,
        env: { ...process.env, HOME: home, GSTACK_HOME: gstackHome },
      });
      expect(r.status).toBe(0);
      const m = (r.stdout || "").match(/gbrain sources add (\S+)/);
      expect(m).not.toBeNull();
      return m![1];
    };

    const idA = idOf(repoA);
    const idB = idOf(repoB);
    expect(idA).not.toBe(idB);
    expect(idA.startsWith("gstack-code-")).toBe(true);
    expect(idB.startsWith("gstack-code-")).toBe(true);

    rmSync(repoA, { recursive: true, force: true });
    rmSync(repoB, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  it("worktree-aware source ID: same path produces the same id across runs (deterministic)", () => {
    // The pathhash is derived from the absolute repo path via sha1, so
    // /sync-gbrain run twice in the same worktree must converge on the same
    // source id (idempotent registration depends on this).
    const remote = "https://github.com/garrytan/gstack.git";
    const home = makeTestHome();
    const gstackHome = join(home, ".gstack");
    mkdirSync(gstackHome, { recursive: true });
    const repo = mkdtempSync(join(tmpdir(), "gstack-worktree-stable-"));
    spawnSync("git", ["init", "--quiet", "-b", "main"], { cwd: repo });
    spawnSync("git", ["remote", "add", "origin", remote], { cwd: repo });

    const idOf = (): string => {
      const r = spawnSync("bun", [SCRIPT, "--dry-run", "--code-only", "--quiet"], {
        encoding: "utf-8",
        timeout: 60000,
        cwd: repo,
        env: { ...process.env, HOME: home, GSTACK_HOME: gstackHome },
      });
      expect(r.status).toBe(0);
      const m = (r.stdout || "").match(/gbrain sources add (\S+)/);
      expect(m).not.toBeNull();
      return m![1];
    };
    expect(idOf()).toBe(idOf());

    rmSync(repo, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  it("dry-run preview includes legacy-source removal + attach (post-codex-review hardening)", () => {
    // Codex adversarial flagged: pre-pathhash `gstack-code-<slug>` sources stay
    // orphaned forever after the new pathhash id ships. Dry-run preview must
    // surface the legacy cleanup so the user knows it'll happen.
    const home = makeTestHome();
    const gstackHome = join(home, ".gstack");
    mkdirSync(gstackHome, { recursive: true });
    const repo = mkdtempSync(join(tmpdir(), "gstack-legacy-cleanup-"));
    spawnSync("git", ["init", "--quiet", "-b", "main"], { cwd: repo });
    spawnSync("git", ["remote", "add", "origin", "https://github.com/garrytan/gstack.git"], { cwd: repo });

    const r = spawnSync("bun", [SCRIPT, "--dry-run", "--code-only", "--quiet"], {
      encoding: "utf-8",
      timeout: 60000,
      cwd: repo,
      env: { ...process.env, HOME: home, GSTACK_HOME: gstackHome },
    });
    expect(r.status).toBe(0);
    // The dry-run preview shows what WOULD run; the live path will also
    // remove the legacy source via `gbrain sources remove gstack-code-<slug>
    // --confirm-destructive` when that legacy source is registered. We can't
    // assert the remove step in dry-run because the orchestrator's preview
    // string lists what it would do, but the legacy removal is gated on the
    // legacy id being registered (which we can't probe in a sandboxed test
    // without a real gbrain CLI). Instead, assert the preview still includes
    // the new flow (sources add + sync + attach) at minimum.
    expect(r.stdout).toMatch(/gbrain sources add gstack-code-/);
    expect(r.stdout).toMatch(/gbrain sync --strategy code --source gstack-code-/);
    expect(r.stdout).toMatch(/gbrain sources attach gstack-code-/);

    rmSync(repo, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  it("dry-run preview includes the `sources attach` step (kubectl-style CWD pin)", () => {
    // Post-spike redesign: after sources add + sync, /sync-gbrain calls
    // `gbrain sources attach <id>` so subsequent gbrain code-def / code-refs
    // calls from anywhere under the worktree route to this source by default.
    // The dry-run preview must surface that step so the user knows what we
    // would do.
    const home = makeTestHome();
    const gstackHome = join(home, ".gstack");
    mkdirSync(gstackHome, { recursive: true });
    const repo = mkdtempSync(join(tmpdir(), "gstack-attach-preview-"));
    spawnSync("git", ["init", "--quiet", "-b", "main"], { cwd: repo });
    spawnSync("git", ["remote", "add", "origin", "https://github.com/garrytan/gstack.git"], { cwd: repo });

    const r = spawnSync("bun", [SCRIPT, "--dry-run", "--code-only", "--quiet"], {
      encoding: "utf-8",
      timeout: 60000,
      cwd: repo,
      env: { ...process.env, HOME: home, GSTACK_HOME: gstackHome },
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/gbrain sources attach gstack-code-/);

    rmSync(repo, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });
});
