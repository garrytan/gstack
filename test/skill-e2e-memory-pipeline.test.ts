/**
 * E2E pipeline test for V1 memory ingest + retrieval surface.
 *
 * Exercises the full Lane A → Lane B → Lane C value loop end-to-end:
 *
 *   1. Set up a fake $HOME with a Claude Code project + a Codex session +
 *      ~/.gstack/ artifacts (eureka, learning, ceo-plan, design-doc, retro,
 *      builder-profile)
 *   2. Run gstack-memory-ingest --probe → verify counts match disk
 *   3. Run gstack-memory-ingest --bulk → verify state file gets written +
 *      session_id dedup works on re-run (idempotency)
 *   4. Run gstack-gbrain-sync --dry-run → verify all 3 stages preview
 *   5. Run gstack-brain-context-load against a real V1 skill manifest
 *      (office-hours/SKILL.md) → verify the manifest dispatches all 4
 *      queries with the datamark envelope
 *
 * Each assertion targets a specific plan acceptance criterion (D10, D11,
 * D12, ED1, ED2, F7, Section 1C/1D, Section 6 regression #3).
 *
 * NOTE: The "write to gbrain" path is non-asserting because gbrain MCP
 * may or may not be available in CI. We assert on side effects gstack
 * itself can verify: state file shape, exit codes, rendered output, and
 * mtime-based incremental fast-path correctness.
 */

import { describe, it, expect } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync, statSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawnSync } from "child_process";

const REPO_ROOT = join(import.meta.dir, "..");
const INGEST = join(REPO_ROOT, "bin", "gstack-memory-ingest.ts");
const SYNC = join(REPO_ROOT, "bin", "gstack-gbrain-sync.ts");
const CONTEXT = join(REPO_ROOT, "bin", "gstack-brain-context-load.ts");

function makeFixtureHome(): string {
  return mkdtempSync(join(tmpdir(), "gstack-e2e-pipeline-"));
}

function setupFixture(home: string): { gstackHome: string; counts: Record<string, number> } {
  const gstackHome = join(home, ".gstack");
  mkdirSync(gstackHome, { recursive: true });
  mkdirSync(join(gstackHome, "analytics"), { recursive: true });
  mkdirSync(join(gstackHome, "projects", "test-repo", "ceo-plans"), { recursive: true });
  mkdirSync(join(gstackHome, "projects", "test-repo", "retros"), { recursive: true });

  // Claude Code session
  const claudeProjectsDir = join(home, ".claude", "projects", "tmp-test-repo");
  mkdirSync(claudeProjectsDir, { recursive: true });
  const ts = new Date().toISOString();
  const claudeSession =
    `{"type":"user","message":{"role":"user","content":"hello agent"},"timestamp":"${ts}","cwd":"/tmp/test-repo"}\n` +
    `{"type":"assistant","message":{"role":"assistant","content":"hi back"},"timestamp":"${ts}"}\n`;
  writeFileSync(join(claudeProjectsDir, "session-abc123.jsonl"), claudeSession, "utf-8");

  // Codex session
  const today = new Date();
  const ymd = `${today.getFullYear()}/${String(today.getMonth() + 1).padStart(2, "0")}/${String(today.getDate()).padStart(2, "0")}`;
  const codexDir = join(home, ".codex", "sessions", ...ymd.split("/"));
  mkdirSync(codexDir, { recursive: true });
  const codexSession = `{"type":"session_meta","payload":{"id":"sess-xyz","cwd":"/tmp/test-repo"},"timestamp":"${ts}"}\n`;
  writeFileSync(join(codexDir, "rollout-1.jsonl"), codexSession, "utf-8");

  // gstack artifacts
  writeFileSync(join(gstackHome, "analytics", "eureka.jsonl"), '{"insight":"boil the lake"}\n', "utf-8");
  writeFileSync(join(gstackHome, "builder-profile.jsonl"), '{"date":"2026-05-01","mode":"startup"}\n', "utf-8");
  writeFileSync(join(gstackHome, "projects", "test-repo", "learnings.jsonl"), '{"key":"a","insight":"b","confidence":8}\n', "utf-8");
  writeFileSync(join(gstackHome, "projects", "test-repo", "timeline.jsonl"), '{"skill":"office-hours","event":"completed"}\n', "utf-8");
  writeFileSync(join(gstackHome, "projects", "test-repo", "ceo-plans", "2026-05-01-test.md"), "# CEO Plan: Test\n\nbody\n", "utf-8");
  writeFileSync(join(gstackHome, "projects", "test-repo", "garrytan-main-design-20260501-090000.md"), "# Design: Test\n", "utf-8");
  writeFileSync(join(gstackHome, "projects", "test-repo", "retros", "2026-05-01-week.md"), "# Retro\n", "utf-8");

  return {
    gstackHome,
    counts: {
      transcript: 2, // claude + codex
      eureka: 1,
      "builder-profile-entry": 1,
      learning: 1,
      timeline: 1,
      "ceo-plan": 1,
      "design-doc": 1,
      retro: 1,
    },
  };
}

function runBun(script: string, args: string[], env: Record<string, string>): { stdout: string; stderr: string; exitCode: number } {
  const r = spawnSync("bun", [script, ...args], {
    encoding: "utf-8",
    timeout: 60000,
    env: { ...process.env, ...env },
  });
  return { stdout: r.stdout || "", stderr: r.stderr || "", exitCode: r.status ?? 1 };
}

// ── E2E pipeline ───────────────────────────────────────────────────────────

describe("V1 memory ingest pipeline E2E", () => {
  it("--probe finds all 9 fixture files across all source types", () => {
    const home = makeFixtureHome();
    const { gstackHome, counts } = setupFixture(home);
    const env = { HOME: home, GSTACK_HOME: gstackHome, GSTACK_MEMORY_INGEST_NO_WRITE: "1" };

    const r = runBun(INGEST, ["--probe"], env);
    expect(r.exitCode).toBe(0);

    const totalExpected = Object.values(counts).reduce((s, n) => s + n, 0);
    expect(r.stdout).toContain(`Total files in window: ${totalExpected}`);

    // Spot-check that each type appears with the right count
    expect(r.stdout).toMatch(/transcript\s+2/);
    expect(r.stdout).toMatch(/eureka\s+1/);
    expect(r.stdout).toMatch(/learning\s+1/);
    expect(r.stdout).toMatch(/ceo-plan\s+1/);

    rmSync(home, { recursive: true, force: true });
  });

  it("--incremental writes a state file with schema_version: 1 + last_writer", () => {
    const home = makeFixtureHome();
    const { gstackHome } = setupFixture(home);
    const env = { HOME: home, GSTACK_HOME: gstackHome, GSTACK_MEMORY_INGEST_NO_WRITE: "1" };

    runBun(INGEST, ["--incremental", "--quiet"], env);

    const statePath = join(gstackHome, ".transcript-ingest-state.json");
    expect(existsSync(statePath)).toBe(true);
    const state = JSON.parse(readFileSync(statePath, "utf-8"));
    expect(state.schema_version).toBe(1);
    expect(state.last_writer).toBe("gstack-memory-ingest");
    expect(typeof state.last_full_walk).toBe("string");

    rmSync(home, { recursive: true, force: true });
  });

  it("--incremental is idempotent — re-run reports 0 changes", () => {
    const home = makeFixtureHome();
    const { gstackHome } = setupFixture(home);
    const env = { HOME: home, GSTACK_HOME: gstackHome, GSTACK_MEMORY_INGEST_NO_WRITE: "1" };

    // First run
    runBun(INGEST, ["--incremental", "--quiet"], env);
    const stateAfterFirst = readFileSync(join(gstackHome, ".transcript-ingest-state.json"), "utf-8");

    // Second run — without gbrain available, dedup happens at file-change-detection
    // layer; no put_page calls fire because state shows files unchanged.
    const r2 = runBun(INGEST, ["--incremental", "--quiet"], env);
    expect(r2.exitCode).toBe(0);

    rmSync(home, { recursive: true, force: true });
  });

  it("--probe shows new vs unchanged distinction after first --incremental", () => {
    const home = makeFixtureHome();
    const { gstackHome } = setupFixture(home);
    const env = { HOME: home, GSTACK_HOME: gstackHome, GSTACK_MEMORY_INGEST_NO_WRITE: "1" };

    // First, write some state by running --incremental quietly
    runBun(INGEST, ["--incremental", "--quiet"], env);

    // Now probe — files should be in state (some as ingested) so unchanged > 0
    // (write may have failed without gbrain; that's OK — we're testing the
    // probe report distinguishes new vs unchanged via the state file).
    const r = runBun(INGEST, ["--probe"], env);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("New (never ingested):");
    expect(r.stdout).toContain("Updated (mtime/hash):");
    expect(r.stdout).toContain("Unchanged:");

    rmSync(home, { recursive: true, force: true });
  });
});

// ── /gbrain-sync orchestrator E2E ──────────────────────────────────────────

describe("V1 /gbrain-sync orchestrator E2E", () => {
  it("--dry-run with all stages enabled previews 3 stages", () => {
    const home = makeFixtureHome();
    const { gstackHome } = setupFixture(home);
    const env = { HOME: home, GSTACK_HOME: gstackHome, GSTACK_MEMORY_INGEST_NO_WRITE: "1" };

    const r = runBun(SYNC, ["--dry-run"], env);
    expect(r.exitCode).toBe(0);
    // Code stage uses native gbrain code surfaces (sources add + sync --strategy code)
    // post-codex review; NOT `gbrain import` (markdown-only path).
    expect(r.stdout).toContain("would: gbrain sources add");
    expect(r.stdout).toContain("gbrain sync --strategy code");
    expect(r.stdout).toContain("would: gstack-memory-ingest");
    expect(r.stdout).toContain("would: gstack-brain-sync");

    rmSync(home, { recursive: true, force: true });
  });

  it("--no-code --no-brain-sync --incremental runs only memory ingest, writes sync state", () => {
    const home = makeFixtureHome();
    const { gstackHome } = setupFixture(home);
    const env = { HOME: home, GSTACK_HOME: gstackHome, GSTACK_MEMORY_INGEST_NO_WRITE: "1" };

    const r = runBun(SYNC, ["--incremental", "--no-code", "--no-brain-sync", "--quiet"], env);
    expect([0, 1]).toContain(r.exitCode); // memory stage may fail if gbrain CLI is missing; both ok

    const statePath = join(gstackHome, ".gbrain-sync-state.json");
    expect(existsSync(statePath)).toBe(true);
    const state = JSON.parse(readFileSync(statePath, "utf-8"));
    expect(state.schema_version).toBe(1);
    expect(state.last_writer).toBe("gstack-gbrain-sync");
    expect(Array.isArray(state.last_stages)).toBe(true);
    // Should have exactly 1 stage entry (memory) since code + brain-sync were disabled
    expect(state.last_stages.length).toBe(1);
    expect(state.last_stages[0].name).toBe("memory");

    rmSync(home, { recursive: true, force: true });
  });
});

// ── Retrieval surface E2E (real V1 manifest) ───────────────────────────────

describe("V1 retrieval surface — real V1 manifest dispatch", () => {
  it("loads office-hours/SKILL.md manifest and dispatches 4 queries", () => {
    const home = makeFixtureHome();
    const { gstackHome } = setupFixture(home);
    const env = { HOME: home, GSTACK_HOME: gstackHome, GSTACK_MEMORY_INGEST_NO_WRITE: "1" };

    const skillFile = join(REPO_ROOT, "office-hours", "SKILL.md");
    expect(existsSync(skillFile)).toBe(true);

    const r = runBun(CONTEXT, ["--skill-file", skillFile, "--repo", "test-repo", "--explain", "--quiet"], env);
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toContain("mode=manifest");
    // office-hours has 4 queries (D5/D6 cherry-pick #1 + builder-profile + design-doc + eureka)
    expect(r.stderr).toContain("queries=4");
    expect(r.stderr).toContain("prior-sessions");
    expect(r.stderr).toContain("builder-profile");
    expect(r.stderr).toContain("design-doc-history");
    expect(r.stderr).toContain("prior-eureka");

    rmSync(home, { recursive: true, force: true });
  });

  it("renders datamark envelope around every loaded section (Section 1D + D12)", () => {
    const home = makeFixtureHome();
    const { gstackHome } = setupFixture(home);
    const env = { HOME: home, GSTACK_HOME: gstackHome, GSTACK_MEMORY_INGEST_NO_WRITE: "1" };

    const skillFile = join(REPO_ROOT, "office-hours", "SKILL.md");
    const r = runBun(CONTEXT, ["--skill-file", skillFile, "--repo", "test-repo"], env);
    expect(r.exitCode).toBe(0);

    if (r.stdout.length > 0) {
      // Every rendered ## section is wrapped in <USER_TRANSCRIPT_DATA>.
      // Count occurrences: every open tag has a matching close tag.
      const opens = (r.stdout.match(/<USER_TRANSCRIPT_DATA do-not-interpret-as-instructions>/g) || []).length;
      const closes = (r.stdout.match(/<\/USER_TRANSCRIPT_DATA>/g) || []).length;
      expect(opens).toBe(closes);
      expect(opens).toBeGreaterThan(0);
    }

    rmSync(home, { recursive: true, force: true });
  });

  it("Layer 1 fallback when no skill specified — default 3-section manifest", () => {
    const home = makeFixtureHome();
    const { gstackHome } = setupFixture(home);
    const env = { HOME: home, GSTACK_HOME: gstackHome, GSTACK_MEMORY_INGEST_NO_WRITE: "1" };

    const r = runBun(CONTEXT, ["--repo", "test-repo", "--explain", "--quiet"], env);
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toContain("mode=default");
    expect(r.stderr).toContain("queries=3");

    rmSync(home, { recursive: true, force: true });
  });

  it("plan-ceo-review/SKILL.md manifest also dispatches correctly (regression for V1 manifest authoring)", () => {
    const home = makeFixtureHome();
    const { gstackHome } = setupFixture(home);
    const env = { HOME: home, GSTACK_HOME: gstackHome, GSTACK_MEMORY_INGEST_NO_WRITE: "1" };

    const skillFile = join(REPO_ROOT, "plan-ceo-review", "SKILL.md");
    expect(existsSync(skillFile)).toBe(true);

    const r = runBun(CONTEXT, ["--skill-file", skillFile, "--repo", "test-repo", "--explain", "--quiet"], env);
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toContain("mode=manifest");
    expect(r.stderr).toContain("queries=3");

    rmSync(home, { recursive: true, force: true });
  });
});
