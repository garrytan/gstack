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
});
