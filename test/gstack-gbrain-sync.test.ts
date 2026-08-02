/**
 * Unit tests for bin/gstack-gbrain-sync.ts (Lane B).
 *
 * Tests CLI surface (modes + flags + help). Stage internals (gbrain import,
 * memory ingest, brain-sync push) shell out to external binaries and are
 * exercised by Lane F E2E tests; here we verify orchestration + dry-run
 * preview + state file lifecycle + flag composition.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync, chmodSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawnSync } from "child_process";
import { canonicalSourceDirectory } from "../lib/gbrain-sources";

import {
  derivePathOnlyHashLegacyId,
  planHostnameFoldMigration,
  removePlannedHostnameLegacySource,
  safePathDriftRemove,
  safeSourcesRemove,
  sourceLocalPath,
  checkGbrainVersion,
} from "../bin/gstack-gbrain-sync";

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
  it("enforces the pin-aware GBrain release boundary", () => {
    expect(checkGbrainVersion("gbrain 0.41.37.0")).toMatchObject({
      ok: false,
      detected: "0.41.37.0",
    });
    expect(checkGbrainVersion("gbrain v0.41.38.0")).toEqual({
      ok: true,
      detected: "0.41.38.0",
      reason: "supported",
    });
    expect(checkGbrainVersion("gbrain 0.42.0")).toMatchObject({
      ok: true,
      detected: "0.42.0",
    });
    expect(checkGbrainVersion("not-a-version")).toMatchObject({
      ok: false,
      detected: null,
    });
  });

  it("rejects an installed pre-floor GBrain before any sync mutation", () => {
    const home = makeTestHome();
    const gstackHome = join(home, ".gstack");
    const bindir = join(home, "bin");
    const mutationMarker = join(home, "unexpected-gbrain-command");
    mkdirSync(gstackHome, { recursive: true });
    mkdirSync(bindir, { recursive: true });
    writeFileSync(
      join(bindir, "gbrain"),
      `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "gbrain 0.41.37.0"; exit 0; fi\n: > '${mutationMarker}'\nexit 0\n`,
    );
    chmodSync(join(bindir, "gbrain"), 0o755);

    try {
      const r = runScript(["--incremental", "--code-only", "--quiet"], {
        HOME: home,
        GSTACK_HOME: gstackHome,
        PATH: `${bindir}:${process.env.PATH || ""}`,
      });
      expect(r.exitCode).toBe(3);
      expect(r.stderr).toContain("below the required 0.41.38.0");
      expect(existsSync(mutationMarker)).toBe(false);
      expect(existsSync(join(gstackHome, ".sync-gbrain.lock"))).toBe(false);
      expect(existsSync(join(gstackHome, ".gbrain-sync-state.json"))).toBe(
        false,
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("rejects a present GBrain with unverifiable version output before mutation", () => {
    const home = makeTestHome();
    const gstackHome = join(home, ".gstack");
    const bindir = join(home, "bin");
    const mutationMarker = join(home, "unexpected-gbrain-command");
    mkdirSync(gstackHome, { recursive: true });
    mkdirSync(bindir, { recursive: true });
    writeFileSync(
      join(bindir, "gbrain"),
      `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "gbrain development-build"; exit 0; fi\n: > '${mutationMarker}'\nexit 0\n`,
    );
    chmodSync(join(bindir, "gbrain"), 0o755);

    try {
      const r = runScript(["--incremental", "--code-only", "--quiet"], {
        HOME: home,
        GSTACK_HOME: gstackHome,
        PATH: `${bindir}:${process.env.PATH || ""}`,
      });
      expect(r.exitCode).toBe(3);
      expect(r.stderr).toContain("could not parse `gbrain --version`");
      expect(existsSync(mutationMarker)).toBe(false);
      expect(existsSync(join(gstackHome, ".sync-gbrain.lock"))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

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

  it("uses the shared local gbrain status classifier instead of shelling through command -v", () => {
    const source = readFileSync(SCRIPT, "utf-8");

    expect(source).not.toContain('command -v gbrain');
    expect(source).toContain("localEngineStatus");
    expect(source).toMatch(/syncArgs\.push\("--repo", canonicalRoot\)/);
    expect(source).toMatch(
      /spawnGbrain\(syncArgs, \{[\s\S]*?cwd: canonicalRoot/,
    );
    expect(source).toMatch(
      /dreamArgs\.push\("--dir", dreamBinding\.canonicalPath\)/,
    );
    expect(source).toMatch(/spawnGbrain\(dreamArgs, \{[\s\S]*?cwd: dreamCwd/);

    const rootCapture = source.indexOf(
      "validatedRoot = canonicalSourceDirectory(root)",
    );
    const stableRootProof = source.indexOf(
      '"repository before sync preflight"',
      rootCapture,
    );
    const engineProbe = source.indexOf(
      "const localStatus = localEngineStatus",
      stableRootProof,
    );
    const legacyCleanup = source.indexOf(
      "safeSourcesRemove(legacyId",
      engineProbe,
    );
    expect(rootCapture).toBeGreaterThan(-1);
    expect(stableRootProof).toBeGreaterThan(rootCapture);
    expect(engineProbe).toBeGreaterThan(stableRootProof);
    expect(legacyCleanup).toBeGreaterThan(engineProbe);

    const finalBindingCheck = source.indexOf(
      'validateCurrentSourceBinding("sync")',
    );
    const finalRootCheck = source.indexOf(
      'revalidateRoot("sync spawn")',
      finalBindingCheck,
    );
    const finalAutopilotCheck = source.indexOf(
      "const apAtSyncSpawn = detectAutopilot",
      finalRootCheck,
    );
    const syncSpawn = source.indexOf(
      "walkResult = spawnGbrain(syncArgs",
      finalAutopilotCheck,
    );
    expect(finalBindingCheck).toBeGreaterThan(-1);
    expect(finalRootCheck).toBeGreaterThan(finalBindingCheck);
    expect(finalAutopilotCheck).toBeGreaterThan(finalRootCheck);
    expect(syncSpawn).toBeGreaterThan(finalAutopilotCheck);
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

  it("derives distinct source ids for the same absolute path on different hosts", () => {
    // Issue #1414: two machines with identical home-dir layouts (chezmoi-managed
    // dotfiles, ansible-provisioned VMs) collide on the same source id when
    // federated against a shared gbrain DB, because the pre-fix `pathHash` was
    // sha1(absolute path) only — host-agnostic. Folding hostname into the hash
    // key keeps them distinct. `GSTACK_HOSTNAME` env var is the test-only knob;
    // production uses `os.hostname()`.
    const home = makeTestHome();
    const gstackHome = join(home, ".gstack");
    mkdirSync(gstackHome, { recursive: true });
    const repo = mkdtempSync(join(tmpdir(), "gstack-host-collide-"));
    spawnSync("git", ["init", "--quiet", "-b", "main"], { cwd: repo });
    spawnSync("git", ["remote", "add", "origin", "https://github.com/example/multihost.git"], { cwd: repo });

    // Dry-run still gates the code stage on `command -v gbrain`. Drop a no-op
    // shim on PATH so the stage runs (we only assert the preview line, never
    // invoke gbrain itself).
    const bindir = mkdtempSync(join(tmpdir(), "gstack-host-collide-bin-"));
    const shim = join(bindir, "gbrain");
    writeFileSync(shim, "#!/bin/sh\nexit 0\n");
    chmodSync(shim, 0o755);
    const PATH = `${bindir}:${process.env.PATH || ""}`;

    const runAs = (host: string) =>
      spawnSync("bun", [SCRIPT, "--dry-run", "--code-only", "--quiet"], {
        encoding: "utf-8",
        timeout: 60000,
        cwd: repo,
        env: { ...process.env, HOME: home, GSTACK_HOME: gstackHome, GSTACK_HOSTNAME: host, PATH },
      });

    const a = runAs("machine-a");
    const b = runAs("machine-b");
    expect(a.status).toBe(0);
    expect(b.status).toBe(0);
    const idA = (a.stdout || "").match(/gbrain sources add (\S+)/)?.[1];
    const idB = (b.stdout || "").match(/gbrain sources add (\S+)/)?.[1];
    expect(idA).toBeTruthy();
    expect(idB).toBeTruthy();
    expect(idA).not.toBe(idB);
    // Both still gbrain-valid.
    const VALID_ID = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
    expect(idA!).toMatch(VALID_ID);
    expect(idB!).toMatch(VALID_ID);

    // Same host + same path stays stable across invocations.
    const a2 = runAs("machine-a");
    expect(a2.status).toBe(0);
    const idA2 = (a2.stdout || "").match(/gbrain sources add (\S+)/)?.[1];
    expect(idA2).toBe(idA);

    rmSync(repo, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
    rmSync(bindir, { recursive: true, force: true });
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

  it("dry-run preview includes legacy-source removal + safe pin (post-codex-review hardening)", () => {
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
    // the new flow (sources add + sync + safe local pin) at minimum.
    expect(r.stdout).toMatch(/gbrain sources add gstack-code-/);
    expect(r.stdout).toMatch(
      /gbrain sync --strategy code --source gstack-code-/,
    );
    expect(r.stdout).toMatch(/pin \.gbrain-source to gstack-code-/);

    rmSync(repo, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  it("dry-run preview includes the symlink-safe local CWD pin", () => {
    // Post-spike redesign: after sources add + sync, /sync-gbrain calls
    // a `.gbrain-source` pin so subsequent gbrain code-def / code-refs
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
    expect(r.stdout).toMatch(/pin \.gbrain-source to gstack-code-/);

    rmSync(repo, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });
});

describe("guarded remove source-id sink", () => {
  it("rejects unsafe ids before spawning pgrep or gbrain", () => {
    const tmp = mkdtempSync(join(tmpdir(), "gstack-remove-id-"));
    const marker = join(tmp, "spawned");
    for (const name of ["pgrep", "gbrain"]) {
      const shim = join(tmp, name);
      writeFileSync(shim, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`);
      chmodSync(shim, 0o755);
    }
    const env = { ...process.env, PATH: tmp };

    try {
      const general = safeSourcesRemove("bad&id", env);
      const drift = safePathDriftRemove("../bad", "/tmp/repo", env);
      expect(general.skipped).toBe(true);
      expect(general.reason).toContain("unsafe source id");
      expect(drift.skipped).toBe(true);
      expect(drift.reason).toContain("unsafe source id");
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("rechecks autopilot after policy I/O and refuses a late start", () => {
    const tmp = mkdtempSync(join(tmpdir(), "gstack-remove-pilot-race-"));
    const count = join(tmp, "pgrep-count");
    const removed = join(tmp, "removed");
    writeFileSync(count, "0\n");
    const pgrep = join(tmp, "pgrep");
    writeFileSync(
      pgrep,
      `#!/bin/sh\nN=$(/bin/cat '${count}')\nN=$((N + 1))\nprintf '%s\\n' "$N" > '${count}'\nif [ "$N" -ge 2 ]; then printf '%s\\n' 'gbrain autopilot'; exit 0; fi\nexit 1\n`,
    );
    chmodSync(pgrep, 0o755);
    const gbrain = join(tmp, "gbrain");
    const registry = JSON.stringify({
      sources: [
        { id: "safe-source", local_path: "/tmp/repo", remote_url: null },
      ],
    });
    writeFileSync(
      gbrain,
      `#!/bin/sh\ncase "$*" in\n  "--version") printf '%s\\n' 'gbrain 9.9.9-race' ;;\n  "call sources_list") printf '%s' '${registry}' ;;\n  "sources remove safe-source --confirm-destructive"*) : > '${removed}' ;;\n  *) exit 0 ;;\nesac\n`,
    );
    chmodSync(gbrain, 0o755);
    const env = {
      ...process.env,
      PATH: tmp,
      GBRAIN_HOME: join(tmp, "home"),
    };

    try {
      const general = safeSourcesRemove("safe-source", env);
      expect(general.skipped).toBe(true);
      expect(general.reason).toContain("became active");
      expect(existsSync(removed)).toBe(false);

      writeFileSync(count, "0\n");
      const drift = safePathDriftRemove("safe-source", "/tmp/repo", env);
      expect(drift.skipped).toBe(true);
      expect(drift.reason).toContain("became active");
      expect(existsSync(removed)).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("executes both guarded remove paths with exact argv for a proven non-empty path", () => {
    const tmp = mkdtempSync(join(tmpdir(), "gstack-remove-success-"));
    const repo = join(tmp, "repo");
    const callLog = join(tmp, "gbrain-calls.log");
    mkdirSync(repo);
    const pgrep = join(tmp, "pgrep");
    writeFileSync(pgrep, "#!/bin/sh\nexit 1\n");
    chmodSync(pgrep, 0o755);
    const registry = JSON.stringify({
      sources: [
        { id: "general-source", local_path: repo, remote_url: null },
        { id: "drift-source", local_path: repo, remote_url: null },
      ],
    });
    makeShim(tmp, {
      "--version": { stdout: "gbrain 99.100.101-remove-success" },
      "sources remove --help": { stdout: "usage: sources remove" },
      "--help": { stdout: "usage: gbrain" },
      "call sources_list": { stdout: registry },
      "sources remove general-source --confirm-destructive": {},
      "sources remove drift-source --confirm-destructive": {},
    });
    const env = {
      ...envWithBindir(tmp),
      GBRAIN_HOME: join(tmp, "gbrain-home"),
      GBRAIN_SHIM_LOG: callLog,
    };

    try {
      expect(repo.length).toBeGreaterThan(0);
      expect(safeSourcesRemove("general-source", env)).toMatchObject({
        removed: true,
        skipped: false,
      });
      expect(safePathDriftRemove("drift-source", repo, env)).toMatchObject({
        removed: true,
        skipped: false,
      });
      const mutationCalls = readFileSync(callLog, "utf-8")
        .trim()
        .split("\n")
        .filter((line) =>
          line === "sources remove general-source --confirm-destructive" ||
          line === "sources remove drift-source --confirm-destructive"
        );
      expect(mutationCalls).toEqual([
        "sources remove general-source --confirm-destructive",
        "sources remove drift-source --confirm-destructive",
      ]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Hostname-fold migration (v1.40.0.0)
//
// Tests for `derivePathOnlyHashLegacyId` and `planHostnameFoldMigration`,
// which together let an existing user's pre-#1468 path-only-hash source
// transition to the new hostname-folded id without orphaning pages or
// creating a data-loss window. See bin/gstack-gbrain-sync.ts and the
// gbrain-sync-hardening plan.
// ──────────────────────────────────────────────────────────────────────────

/**
 * Build a gbrain shim that responds to specific subcommands with canned
 * output, then return PATH-prepend value. Lets us run helpers in-process
 * (which spawn `gbrain` from PATH) without a real gbrain CLI.
 */
function makeShim(bindir: string, responses: Record<string, { stdout?: string; stderr?: string; exit?: number }>): string {
  const shim = join(bindir, "gbrain");
  const cases = Object.entries(responses).map(([key, r]) => {
    const exit = r.exit ?? 0;
    const stdout = (r.stdout || "").replace(/'/g, "'\\''");
    const stderr = (r.stderr || "").replace(/'/g, "'\\''");
    // Patterns with spaces MUST be double-quoted in sh case statements,
    // otherwise the shell parses the second word as the start of the next
    // pattern and errors out.
    return `  "${key}") printf '%s' '${stdout}'; printf '%s' '${stderr}' >&2; exit ${exit} ;;`;
  }).join("\n");
  // Match on the full argument string, joined with literal spaces.
  const script = `#!/bin/sh\nARGS="$*"\nif [ -n "$GBRAIN_SHIM_LOG" ]; then printf '%s\\n' "$ARGS" >> "$GBRAIN_SHIM_LOG"; fi\ncase "$ARGS" in\n${cases}\n  *) echo "shim: no match for [$ARGS]" >&2; exit 1 ;;\nesac\n`;
  writeFileSync(shim, script);
  chmodSync(shim, 0o755);
  return shim;
}

describe("derivePathOnlyHashLegacyId", () => {
  it("returns the pre-#1468 form (path-only sha1, no hostname)", () => {
    // Pure function — no subprocess. The same repoPath must yield the same
    // legacy id regardless of $GSTACK_HOSTNAME, because the pre-#1468 hash
    // didn't include hostname.
    const repo = mkdtempSync(join(tmpdir(), "gstack-legacy-id-"));
    spawnSync("git", ["init", "--quiet", "-b", "main"], { cwd: repo });
    spawnSync("git", ["remote", "add", "origin", "https://github.com/example/legacy-test.git"], { cwd: repo });

    const cwd = process.cwd();
    try {
      process.chdir(repo);
      const a = derivePathOnlyHashLegacyId(repo);
      process.env.GSTACK_HOSTNAME = "machine-a";
      const b = derivePathOnlyHashLegacyId(repo);
      process.env.GSTACK_HOSTNAME = "machine-b";
      const c = derivePathOnlyHashLegacyId(repo);
      expect(a).toBe(b);
      expect(b).toBe(c);
      expect(a.startsWith("gstack-code-")).toBe(true);
      expect(a.length).toBeLessThanOrEqual(32);
    } finally {
      delete process.env.GSTACK_HOSTNAME;
      process.chdir(cwd);
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("produces a different id than the new hostname-folded form", () => {
    // The whole point of the migration: the path-only-hash legacy id and the
    // host-fold id must differ for any non-empty hostname, so the migration
    // can detect + clean up the orphan.
    const repo = mkdtempSync(join(tmpdir(), "gstack-legacy-id-distinct-"));
    spawnSync("git", ["init", "--quiet", "-b", "main"], { cwd: repo });
    spawnSync("git", ["remote", "add", "origin", "https://github.com/example/distinct.git"], { cwd: repo });

    const cwd = process.cwd();
    try {
      process.chdir(repo);
      process.env.GSTACK_HOSTNAME = "machine-x";
      const legacy = derivePathOnlyHashLegacyId(repo);
      // Drive the new id through the CLI so we use the same code path users hit.
      const home = makeTestHome();
      const gstackHome = join(home, ".gstack");
      mkdirSync(gstackHome, { recursive: true });
      const bindir = mkdtempSync(join(tmpdir(), "gstack-legacy-id-distinct-bin-"));
      makeShim(bindir, { "--help": { stdout: "gbrain\n" } });
      const r = spawnSync("bun", [SCRIPT, "--dry-run", "--code-only", "--quiet"], {
        encoding: "utf-8",
        timeout: 60000,
        cwd: repo,
        env: { ...process.env, HOME: home, GSTACK_HOME: gstackHome, GSTACK_HOSTNAME: "machine-x", PATH: `${bindir}:${process.env.PATH || ""}` },
      });
      const newId = (r.stdout || "").match(/gbrain sources add (\S+)/)?.[1];
      expect(newId).toBeTruthy();
      expect(newId).not.toBe(legacy);
      rmSync(home, { recursive: true, force: true });
      rmSync(bindir, { recursive: true, force: true });
    } finally {
      delete process.env.GSTACK_HOSTNAME;
      process.chdir(cwd);
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

/**
 * Build an env dict that prepends `bindir` to PATH. Bun's spawnSync does NOT
 * pick up runtime mutations of `process.env.PATH` — the env must be passed
 * explicitly to each spawn for the override to take effect.
 */
function envWithBindir(bindir: string): NodeJS.ProcessEnv {
  return { ...process.env, PATH: `${bindir}:${process.env.PATH || ""}` };
}

function previewCodeSourceId(
  repo: string,
  env: NodeJS.ProcessEnv,
): string {
  const preview = spawnSync(
    "bun",
    [SCRIPT, "--dry-run", "--code-only", "--quiet"],
    { cwd: repo, env, encoding: "utf-8", timeout: 60000 },
  );
  expect(preview.status).toBe(0);
  const sourceId = (preview.stdout || "").match(
    /gbrain sources add (\S+)/,
  )?.[1];
  if (!sourceId) throw new Error("dry-run did not report a code source id");
  return sourceId;
}

describe("executable source-bound orchestration", () => {
  it("registers, rereads, syncs with the canonical repo, pins, counts pages, then removes the exact legacy row", () => {
    const home = makeTestHome();
    const gstackHome = join(home, ".gstack");
    const gbrainHome = join(home, ".gbrain");
    const bindir = join(home, "bin");
    const repo = join(home, "repo");
    const callLog = join(home, "gbrain-calls.jsonl");
    const registered = join(home, "registered");
    const synced = join(home, "synced");
    const pageCountObserved = join(home, "page-count-observed");
    const legacyRemoved = join(home, "legacy-removed");
    mkdirSync(gstackHome, { recursive: true });
    mkdirSync(gbrainHome, { recursive: true });
    mkdirSync(bindir, { recursive: true });
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(gbrainHome, "config.json"), '{"engine":"postgres"}\n');
    spawnSync("git", ["init", "--quiet", "-b", "main"], { cwd: repo });
    spawnSync(
      "git",
      ["remote", "add", "origin", "https://github.com/example/orchestration.git"],
      { cwd: repo },
    );
    const env = {
      ...process.env,
      HOME: home,
      GSTACK_HOME: gstackHome,
      GBRAIN_HOME: gbrainHome,
      GSTACK_HOSTNAME: "orchestration-test-host",
      PATH: `${bindir}:${process.env.PATH || ""}`,
    };
    const sourceId = previewCodeSourceId(repo, env);
    const reportedRoot = spawnSync(
      "git",
      ["rev-parse", "--show-toplevel"],
      { cwd: repo, encoding: "utf-8" },
    ).stdout.trim();
    const canonicalRoot = canonicalSourceDirectory(reportedRoot).canonicalPath;
    const previousCwd = process.cwd();
    let legacyId: string;
    try {
      process.chdir(repo);
      legacyId = derivePathOnlyHashLegacyId(reportedRoot);
    } finally {
      process.chdir(previousCwd);
    }

    const gbrain = join(bindir, "gbrain");
    writeFileSync(
      gbrain,
      `#!/usr/bin/env bun
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "fs";
const callLog = ${JSON.stringify(callLog)};
const registered = ${JSON.stringify(registered)};
const synced = ${JSON.stringify(synced)};
const pageCountObserved = ${JSON.stringify(pageCountObserved)};
const legacyRemoved = ${JSON.stringify(legacyRemoved)};
const sourceId = ${JSON.stringify(sourceId)};
const legacyId = ${JSON.stringify(legacyId)};
const root = ${JSON.stringify(canonicalRoot)};
const pinPath = root + "/.gbrain-source";
const args = process.argv.slice(2);
const key = args.join(" ");
const pin = existsSync(pinPath) ? readFileSync(pinPath, "utf-8").trim() : null;
appendFileSync(callLog, JSON.stringify({ args, cwd: process.cwd(), noGitignore: process.env.GBRAIN_NO_GITIGNORE || "", pin }) + "\\n");
const same = (expected) => JSON.stringify(args) === JSON.stringify(expected);
const list = () => {
  const sources = [];
  if (!existsSync(legacyRemoved)) {
    sources.push({ id: legacyId, local_path: root, remote_url: null, page_count: 9 });
  }
  if (existsSync(registered)) {
    sources.push({ id: sourceId, local_path: root, remote_url: null, page_count: existsSync(synced) ? 4 : 0 });
  }
  return JSON.stringify({ sources });
};
if (same(["--version"])) {
  console.log("gbrain 0.41.38.0");
} else if (same(["sources", "list", "--json"])) {
  if (existsSync(synced) && pin === sourceId) writeFileSync(pageCountObserved, "yes");
  process.stdout.write(list());
} else if (same(["call", "sources_list"])) {
  process.stdout.write(list());
} else if (same(["sources", "remove", "--help"])) {
  process.stdout.write("usage: sources remove");
} else if (same(["--help"])) {
  process.stdout.write("usage: gbrain");
} else if (same(["sources", "add", sourceId, "--path", root, "--federated"])) {
  writeFileSync(registered, "yes");
} else if (same(["sync", "--strategy", "code", "--source", sourceId, "--repo", root])) {
  if (process.cwd() !== root || process.env.GBRAIN_NO_GITIGNORE !== "1" || !existsSync(registered)) process.exit(41);
  writeFileSync(synced, "yes");
} else if (same(["sources", "remove", legacyId, "--confirm-destructive"])) {
  if (!existsSync(pageCountObserved) || pin !== sourceId) process.exit(42);
  writeFileSync(legacyRemoved, "yes");
} else {
  console.error("unexpected gbrain argv: " + key);
  process.exit(90);
}
`,
    );
    chmodSync(gbrain, 0o755);
    writeFileSync(join(bindir, "pgrep"), "#!/bin/sh\nexit 1\n");
    chmodSync(join(bindir, "pgrep"), 0o755);

    try {
      const result = spawnSync(
        "bun",
        [SCRIPT, "--incremental", "--code-only", "--quiet"],
        { cwd: repo, env, encoding: "utf-8", timeout: 60000 },
      );
      expect({
        status: result.status,
        stdout: result.stdout,
        stderr: result.stderr,
      }).toMatchObject({ status: 0 });
      expect(readFileSync(join(canonicalRoot, ".gbrain-source"), "utf-8")).toBe(
        `${sourceId}\n`,
      );
      expect(existsSync(pageCountObserved)).toBe(true);
      expect(existsSync(legacyRemoved)).toBe(true);

      const calls = readFileSync(callLog, "utf-8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as {
          args: string[];
          cwd: string;
          noGitignore: string;
          pin: string | null;
        });
      const addArgs = [
        "sources", "add", sourceId, "--path", canonicalRoot, "--federated",
      ];
      const syncArgs = [
        "sync", "--strategy", "code", "--source", sourceId, "--repo", canonicalRoot,
      ];
      const removeArgs = [
        "sources", "remove", legacyId, "--confirm-destructive",
      ];
      const addIndex = calls.findIndex((call) =>
        JSON.stringify(call.args) === JSON.stringify(addArgs)
      );
      const syncIndex = calls.findIndex((call) =>
        JSON.stringify(call.args) === JSON.stringify(syncArgs)
      );
      const pageCountIndex = calls.findIndex(
        (call, index) =>
          index > syncIndex &&
          JSON.stringify(call.args) ===
            JSON.stringify(["sources", "list", "--json"]) &&
          call.pin === sourceId,
      );
      const removeIndex = calls.findIndex((call) =>
        JSON.stringify(call.args) === JSON.stringify(removeArgs)
      );
      expect(addIndex).toBeGreaterThan(-1);
      expect(syncIndex).toBeGreaterThan(addIndex);
      expect(
        calls.slice(addIndex + 1, syncIndex).some((call) =>
          JSON.stringify(call.args) === JSON.stringify(["call", "sources_list"])
        ),
      ).toBe(true);
      expect(calls[syncIndex]).toMatchObject({
        cwd: canonicalRoot,
        noGitignore: "1",
      });
      expect(pageCountIndex).toBeGreaterThan(syncIndex);
      expect(removeIndex).toBeGreaterThan(pageCountIndex);
      expect(
        calls.filter((call) => call.args[0] === "sources" && call.args[1] === "remove" && call.args[2] !== "--help")
          .map((call) => call.args),
      ).toEqual([removeArgs]);
      expect(readFileSync(join(canonicalRoot, ".gitignore"), "utf-8")).toContain(
        ".gbrain-source",
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("runs source-bound dream in the canonical repo and preserves its non-zero failure", () => {
    const home = makeTestHome();
    const gstackHome = join(home, ".gstack");
    const gbrainHome = join(home, ".gbrain");
    const bindir = join(home, "bin");
    const repo = join(home, "repo");
    const callLog = join(home, "dream-calls.jsonl");
    mkdirSync(gstackHome, { recursive: true });
    mkdirSync(gbrainHome, { recursive: true });
    mkdirSync(bindir, { recursive: true });
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(gbrainHome, "config.json"), '{"engine":"postgres"}\n');
    spawnSync("git", ["init", "--quiet", "-b", "main"], { cwd: repo });
    spawnSync(
      "git",
      ["remote", "add", "origin", "https://github.com/example/dream.git"],
      { cwd: repo },
    );
    const env = {
      ...process.env,
      HOME: home,
      GSTACK_HOME: gstackHome,
      GBRAIN_HOME: gbrainHome,
      GSTACK_HOSTNAME: "dream-test-host",
      PATH: `${bindir}:${process.env.PATH || ""}`,
    };
    const sourceId = previewCodeSourceId(repo, env);
    const reportedRoot = spawnSync(
      "git",
      ["rev-parse", "--show-toplevel"],
      { cwd: repo, encoding: "utf-8" },
    ).stdout.trim();
    const canonicalRoot = canonicalSourceDirectory(reportedRoot).canonicalPath;
    const dreamArgs = [
      "dream", "--source", sourceId, "--dir", canonicalRoot,
    ];
    const gbrain = join(bindir, "gbrain");
    writeFileSync(
      gbrain,
      `#!/usr/bin/env bun
import { appendFileSync } from "fs";
const callLog = ${JSON.stringify(callLog)};
const sourceId = ${JSON.stringify(sourceId)};
const root = ${JSON.stringify(canonicalRoot)};
const args = process.argv.slice(2);
appendFileSync(callLog, JSON.stringify({ args, cwd: process.cwd() }) + "\\n");
const same = (expected) => JSON.stringify(args) === JSON.stringify(expected);
const list = JSON.stringify({ sources: [{ id: sourceId, local_path: root, remote_url: null, page_count: 4 }] });
if (same(["--version"])) console.log("gbrain 0.41.38.0");
else if (same(["sources", "list", "--json"]) || same(["call", "sources_list"])) process.stdout.write(list);
else if (same(["dream", "--source", sourceId, "--dir", root])) process.exit(17);
else process.exit(90);
`,
    );
    chmodSync(gbrain, 0o755);

    try {
      const result = spawnSync(
        "bun",
        [
          SCRIPT,
          "--incremental",
          "--no-code",
          "--no-memory",
          "--no-brain-sync",
          "--dream",
          "--quiet",
        ],
        { cwd: repo, env, encoding: "utf-8", timeout: 60000 },
      );
      expect(result.status).toBe(1);
      const calls = readFileSync(callLog, "utf-8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { args: string[]; cwd: string });
      const dreamCalls = calls.filter((call) =>
        JSON.stringify(call.args) === JSON.stringify(dreamArgs)
      );
      expect(dreamCalls).toEqual([{ args: dreamArgs, cwd: canonicalRoot }]);
      const state = JSON.parse(
        readFileSync(join(gstackHome, ".gbrain-sync-state.json"), "utf-8"),
      ) as { last_stages?: Array<{ name: string; ok: boolean; summary: string }> };
      expect(state.last_stages?.find((stage) => stage.name === "dream"))
        .toMatchObject({
          ok: false,
          summary: "gbrain dream exited 17",
        });
      expect(existsSync(join(gstackHome, ".dream-in-progress"))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("planHostnameFoldMigration", () => {
  let bindir: string;

  beforeEach(() => {
    bindir = mkdtempSync(join(tmpdir(), "gstack-mig-plan-bin-"));
  });
  afterEach(() => {
    rmSync(bindir, { recursive: true, force: true });
  });

  it("returns ids-match when legacy == new (degenerate case)", () => {
    const result = planHostnameFoldMigration("/repo/path", "gstack-code-same-abc12345", "gstack-code-same-abc12345");
    expect(result).toEqual({ kind: "none", reason: "ids-match" });
  });

  it("returns no-legacy-source when sources list does not include the legacy id", () => {
    makeShim(bindir, {
      "sources list --json": { stdout: "[]" },
    });
    const result = planHostnameFoldMigration("/repo/path", "new-id", "legacy-id", envWithBindir(bindir));
    expect(result).toEqual({ kind: "none", reason: "no-legacy-source" });
  });

  it("returns skipped-path-drift when old source local_path differs from current repo root", () => {
    makeShim(bindir, {
      "sources list --json": {
        stdout: JSON.stringify([{ id: "legacy-id", local_path: "/some/other/repo" }]),
      },
    });
    const result = planHostnameFoldMigration("/repo/here", "new-id", "legacy-id", envWithBindir(bindir));
    expect(result.kind).toBe("skipped-path-drift");
    if (result.kind === "skipped-path-drift") {
      expect(result.oldId).toBe("legacy-id");
      expect(result.oldPath).toBe("/some/other/repo");
      expect(result.currentPath).toBe("/repo/here");
    }
  });

  it("treats stored dot as the same legacy source by canonical identity", () => {
    const repo = mkdtempSync(join(tmpdir(), "gstack-mig-dot-"));
    makeShim(bindir, {
      "sources list --json": {
        stdout: JSON.stringify([{ id: "legacy-id", local_path: "." }]),
      },
    });

    try {
      const expected = canonicalSourceDirectory(repo);
      const result = planHostnameFoldMigration(
        repo,
        "new-id",
        "legacy-id",
        envWithBindir(bindir),
        { expected },
      );
      expect(result).toEqual({
        kind: "pending-cleanup",
        oldId: "legacy-id",
        oldPath: ".",
      });
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("never mutates with rename even when a CLI advertises it", () => {
    const callLog = join(bindir, "calls.log");
    makeShim(bindir, {
      "sources list --json": {
        stdout: JSON.stringify([{ id: "legacy-id", local_path: "/repo/here" }]),
      },
      "sources rename --help": {
        exit: 99,
        stderr: "rename capability probe must not run",
      },
      "sources rename legacy-id new-id": {
        exit: 99,
        stderr: "rename mutation must not run",
      },
    });
    const result = planHostnameFoldMigration(
      "/repo/here",
      "new-id",
      "legacy-id",
      { ...envWithBindir(bindir), GBRAIN_SHIM_LOG: callLog },
    );
    expect(result).toEqual({
      kind: "pending-cleanup",
      oldId: "legacy-id",
      oldPath: "/repo/here",
    });
    expect(readFileSync(callLog, "utf-8").trim()).toBe("sources list --json");
  });

  it("returns pending-cleanup for a matching legacy source", () => {
    makeShim(bindir, {
      "sources list --json": {
        stdout: JSON.stringify([{ id: "legacy-id", local_path: "/repo/here" }]),
      },
    });
    const result = planHostnameFoldMigration("/repo/here", "new-id", "legacy-id", envWithBindir(bindir));
    expect(result).toEqual({
      kind: "pending-cleanup",
      oldId: "legacy-id",
      oldPath: "/repo/here",
    });
  });

  it("refuses cleanup when the planned legacy id is rebound during sync", () => {
    const callLog = join(bindir, "calls.log");
    makeShim(bindir, {
      "sources list --json": {
        stdout: JSON.stringify([
          { id: "legacy-id", local_path: "/repo/original" },
        ]),
      },
    });
    const env = {
      ...envWithBindir(bindir),
      GBRAIN_SHIM_LOG: callLog,
      GBRAIN_HOME: join(bindir, "gbrain-home"),
    };
    const migration = planHostnameFoldMigration(
      "/repo/original",
      "new-id",
      "legacy-id",
      env,
    );
    expect(migration).toEqual({
      kind: "pending-cleanup",
      oldId: "legacy-id",
      oldPath: "/repo/original",
    });
    if (migration.kind !== "pending-cleanup") {
      throw new Error("expected a pending hostname-fold cleanup");
    }

    makeShim(bindir, {
      "call sources_list": {
        stdout: JSON.stringify({
          sources: [
            {
              id: "legacy-id",
              local_path: "/repo/replacement",
              remote_url: null,
            },
          ],
        }),
      },
      "--version": { stdout: "gbrain 0.41.38.0" },
      "sources remove --help": { stdout: "--keep-storage" },
      "sources remove legacy-id --confirm-destructive": {
        exit: 99,
        stderr: "replacement row must not be removed",
      },
      "sources remove legacy-id --confirm-destructive --keep-storage": {
        exit: 99,
        stderr: "replacement row must not be removed",
      },
    });

    const cleanup = removePlannedHostnameLegacySource(migration, env);
    expect(cleanup.removed).toBe(false);
    expect(cleanup.skipped).toBe(true);
    expect(cleanup.reason).toContain("changed after validation");
    expect(readFileSync(callLog, "utf-8")).not.toContain(
      "sources remove legacy-id --confirm-destructive",
    );
  });
});

describe("constrainSourceId truncation (hyphen-boundary cut)", () => {
  // PR #1481 (Drummerms): the old slug.slice(-tailBudget) cut mid-word when
  // the boundary fell inside a token. For a long repo like
  // `drummerms-av-sow-wiz-skill-270c0001` the truncated tail used to end in
  // `kill-270c0001` (from `skill`). The new tokenized cut walks hyphen
  // boundaries from the right and only keeps whole tokens.
  //
  // Exercised via the dry-run preview (`gbrain sources add gstack-code-…`),
  // since constrainSourceId is module-private.
  it("never produces mid-word truncation artifacts like `kill` (from `skill`)", () => {
    const home = makeTestHome();
    const gstackHome = join(home, ".gstack");
    mkdirSync(gstackHome, { recursive: true });
    const repo = mkdtempSync(join(tmpdir(), "gstack-hyphen-cut-"));
    spawnSync("git", ["init", "--quiet", "-b", "main"], { cwd: repo });
    // Remote chosen to be long enough that constrainSourceId truncates and
    // the boundary lands inside the word `skill`.
    spawnSync("git", ["remote", "add", "origin", "https://github.com/drummerms-av-sow-wiz/skill-270c0001.git"], { cwd: repo });

    const r = spawnSync("bun", [SCRIPT, "--dry-run", "--code-only", "--quiet"], {
      encoding: "utf-8",
      timeout: 60000,
      cwd: repo,
      env: { ...process.env, HOME: home, GSTACK_HOME: gstackHome },
    });
    expect(r.status).toBe(0);
    const id = (r.stdout || "").match(/gbrain sources add (\S+)/)?.[1];
    expect(id).toBeTruthy();
    // The id must not contain the mid-word fragment `kill` (left over from
    // slicing inside `skill`). Tokens that survive truncation must be whole.
    expect(id).not.toMatch(/(^|-)kill(-|$)/);
    // Still gbrain-valid.
    expect(id!.length).toBeLessThanOrEqual(32);
    expect(id!).toMatch(/^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/);

    rmSync(repo, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  // Closes #1357: HTTPS remotes ending in `.git` used to pass periods through
  // to the source id. canonicalizeRemote strips the `.git` suffix; the
  // sanitizer also strips any residual non-alnum. Test asserts the source id
  // is period-free for the exact case from the issue.
  it("produces a period-free source id for HTTPS remotes ending in .git (#1357)", () => {
    const home = makeTestHome();
    const gstackHome = join(home, ".gstack");
    mkdirSync(gstackHome, { recursive: true });
    const repo = mkdtempSync(join(tmpdir(), "gstack-https-period-"));
    spawnSync("git", ["init", "--quiet", "-b", "main"], { cwd: repo });
    spawnSync("git", ["remote", "add", "origin", "https://github.com/foo/bar.git"], { cwd: repo });

    const r = spawnSync("bun", [SCRIPT, "--dry-run", "--code-only", "--quiet"], {
      encoding: "utf-8",
      timeout: 60000,
      cwd: repo,
      env: { ...process.env, HOME: home, GSTACK_HOME: gstackHome },
    });
    expect(r.status).toBe(0);
    const id = (r.stdout || "").match(/gbrain sources add (\S+)/)?.[1];
    expect(id).toBeTruthy();
    expect(id).not.toContain(".");
    expect(id!).toMatch(/^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/);

    rmSync(repo, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });
});

describe("sourceLocalPath", () => {
  let bindir: string;
  beforeEach(() => {
    bindir = mkdtempSync(join(tmpdir(), "gstack-source-lp-bin-"));
  });
  afterEach(() => {
    rmSync(bindir, { recursive: true, force: true });
  });

  it("returns local_path when the source exists", () => {
    makeShim(bindir, {
      "sources list --json": {
        stdout: JSON.stringify([
          { id: "other-source", local_path: "/x" },
          { id: "target-id", local_path: "/repo/match" },
        ]),
      },
    });
    expect(sourceLocalPath("target-id", envWithBindir(bindir))).toBe("/repo/match");
  });

  it("returns null when the source is missing", () => {
    makeShim(bindir, {
      "sources list --json": { stdout: "[]" },
    });
    expect(sourceLocalPath("missing-id", envWithBindir(bindir))).toBeNull();
  });

  it("returns null when gbrain exits non-zero or returns malformed JSON", () => {
    makeShim(bindir, {
      "sources list --json": { exit: 2, stderr: "db unreachable" },
    });
    expect(sourceLocalPath("any-id", envWithBindir(bindir))).toBeNull();
  });

  // gbrain v0.20+ wraps the response as `{sources: [...]}`. Older versions
  // returned a flat array. sourceLocalPath was returning null (or crashing
  // with `list.find is not a function` upstream) because it only handled
  // the flat-array shape. Pin both shapes here.
  it("handles {sources: [...]} wrapped shape (gbrain v0.20+)", () => {
    makeShim(bindir, {
      "sources list --json": {
        stdout: JSON.stringify({
          sources: [
            { id: "other-source", local_path: "/x" },
            { id: "target-id", local_path: "/repo/match" },
          ],
        }),
      },
    });
    expect(sourceLocalPath("target-id", envWithBindir(bindir))).toBe("/repo/match");
  });

  it("returns null when the source is missing in the wrapped shape", () => {
    makeShim(bindir, {
      "sources list --json": { stdout: JSON.stringify({ sources: [] }) },
    });
    expect(sourceLocalPath("missing-id", envWithBindir(bindir))).toBeNull();
  });
});
