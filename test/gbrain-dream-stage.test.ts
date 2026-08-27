/**
 * Tests for the dream (call-graph build) stage of bin/gstack-gbrain-sync.ts.
 *
 * We deliberately do NOT exercise a real GBrain backfill in CI. Instead we cover:
 *   1. shouldRunDream() — the pure gate matrix (issues 1/2/4). Highest-risk logic.
 *   2. runDream() dry-run — returns a preview before any engine probe / spawn.
 *   3. Dream marker (acquire/release/stale-takeover) — the concurrency guard.
 *   4. Exact-source output parsing and bounded-pass continuation decisions.
 *   5. CLI gate wiring via --dry-run subprocess (safe: dry-run never backfills).
 *
 * The live spawn + lock-free ordering + serialization are covered by the manual
 * E2E verification in the plan (running the orchestrator against a real brain),
 * not by a unit test that could launch a real dream.
 */

import { describe, it, expect, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, existsSync, readFileSync, writeFileSync, utimesSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawnSync } from "child_process";

import {
  shouldRunDream,
  runDream,
  acquireDreamMarker,
  releaseDreamMarker,
  dreamMarkerPath,
  parseEdgeBackfillSummary,
  parseCallGraphReadiness,
  nextCallGraphPass,
  isGbrainCallGraphVersionSupported,
  MIN_GBRAIN_CALL_GRAPH_VERSION,
  formatStage,
  type CliArgs,
  type EdgeBackfillSummary,
  type CallGraphReadiness,
} from "../bin/gstack-gbrain-sync";

const SCRIPT = join(import.meta.dir, "..", "bin", "gstack-gbrain-sync.ts");

/** Build a CliArgs with all flags off, overriding only what a case needs. */
function args(overrides: Partial<CliArgs> = {}): CliArgs {
  return {
    mode: "incremental",
    quiet: false,
    noCode: false,
    noMemory: false,
    noBrainSync: false,
    codeOnly: false,
    dream: false,
    noDream: false,
    ...overrides,
  };
}

describe("shouldRunDream — gate matrix", () => {
  it("explicit --dream always runs (cycle irrelevant)", () => {
    expect(shouldRunDream(args({ dream: true }), null)).toBe(true);
    expect(shouldRunDream(args({ dream: true }), "completed")).toBe(true);
    expect(shouldRunDream(args({ dream: true }), "never")).toBe(true);
    expect(shouldRunDream(args({ dream: true }), "unknown")).toBe(true);
  });

  it("explicit --dream runs even with --code-only / --no-code (force)", () => {
    expect(shouldRunDream(args({ dream: true, codeOnly: true, noMemory: true, noBrainSync: true }), null)).toBe(true);
    expect(shouldRunDream(args({ dream: true, noCode: true }), null)).toBe(true);
  });

  it("--full always backfills after reindex regardless of old cycle freshness", () => {
    expect(shouldRunDream(args({ mode: "full" }), "never")).toBe(true);
    expect(shouldRunDream(args({ mode: "full" }), "completed")).toBe(true);
    expect(shouldRunDream(args({ mode: "full" }), "unknown")).toBe(true);
    expect(shouldRunDream(args({ mode: "full" }), null)).toBe(true);
  });

  it("--full + --no-dream never auto-runs", () => {
    expect(shouldRunDream(args({ mode: "full", noDream: true }), "never")).toBe(false);
  });

  it("--full + --no-code never auto-runs", () => {
    expect(shouldRunDream(args({ mode: "full", noCode: true }), "never")).toBe(false);
  });

  it("plain incremental never runs (no flag, no full)", () => {
    expect(shouldRunDream(args(), "never")).toBe(false);
    expect(shouldRunDream(args(), null)).toBe(false);
  });
});

describe("GBrain call-graph version floor", () => {
  it("accepts the readiness release and newer 3/4-part stable versions", () => {
    expect(MIN_GBRAIN_CALL_GRAPH_VERSION).toBe("0.42.14");
    expect(isGbrainCallGraphVersionSupported("gbrain 0.42.14.0")).toBe(true);
    expect(isGbrainCallGraphVersionSupported("v0.42.14")).toBe(true);
    expect(isGbrainCallGraphVersionSupported("gbrain0.46.24.0")).toBe(true);
    expect(isGbrainCallGraphVersionSupported("1.0.0")).toBe(true);
  });

  it("rejects older, prerelease, malformed, and missing versions", () => {
    expect(isGbrainCallGraphVersionSupported("gbrain 0.42.13.9")).toBe(false);
    expect(isGbrainCallGraphVersionSupported("0.41.99")).toBe(false);
    expect(isGbrainCallGraphVersionSupported("0.42.14-alpha")).toBe(false);
    expect(isGbrainCallGraphVersionSupported("unknown")).toBe(false);
    expect(isGbrainCallGraphVersionSupported("")).toBe(false);
  });
});

describe("runDream — dry-run preview", () => {
  it("returns a 'would' preview without spawning (ran=false, ok=true)", async () => {
    const r = await runDream(args({ mode: "dry-run", dream: true }));
    expect(r.name).toBe("dream");
    expect(r.ran).toBe(false);
    expect(r.ok).toBe(true);
    expect(r.summary).toContain("would: gbrain edges-backfill");
  });
});

describe("dream marker — concurrency guard", () => {
  const saved = process.env.GSTACK_HOME;
  const savedStateRoot = process.env.GSTACK_STATE_ROOT;
  const savedHome = process.env.HOME;
  const sourceA = "gstack-code-acme-a-11111111";
  const sourceB = "gstack-code-acme-b-22222222";
  let tmp: string;

  afterEach(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    if (saved === undefined) delete process.env.GSTACK_HOME;
    else process.env.GSTACK_HOME = saved;
    if (savedStateRoot === undefined) delete process.env.GSTACK_STATE_ROOT;
    else process.env.GSTACK_STATE_ROOT = savedStateRoot;
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
  });

  function redirectHome(): void {
    tmp = mkdtempSync(join(tmpdir(), "gbrain-dream-marker-"));
    process.env.GSTACK_HOME = tmp;
    process.env.GSTACK_STATE_ROOT = join(tmp, "portable-metadata");
    process.env.HOME = tmp;
  }

  it("acquire creates the marker; a second acquire on a fresh marker fails", () => {
    redirectHome();
    expect(acquireDreamMarker(sourceA)).toBe(true);
    expect(existsSync(dreamMarkerPath(sourceA))).toBe(true);
    expect(dreamMarkerPath(sourceA).startsWith(process.env.GSTACK_HOME!)).toBe(true);
    expect(dreamMarkerPath(sourceA).startsWith(process.env.GSTACK_STATE_ROOT!)).toBe(false);
    // Fresh marker present → a concurrent worktree must NOT launch a duplicate.
    expect(acquireDreamMarker(sourceA)).toBe(false);
  });

  it("serializes different sources on one PGLite engine", () => {
    redirectHome();
    mkdirSync(join(tmp, ".gbrain"), { recursive: true });
    writeFileSync(join(tmp, ".gbrain", "config.json"), JSON.stringify({ engine: "pglite" }));
    expect(acquireDreamMarker(sourceA)).toBe(true);
    expect(acquireDreamMarker(sourceB)).toBe(false);
    expect(dreamMarkerPath(sourceA)).toBe(dreamMarkerPath(sourceB));
  });

  it("allows different sources to backfill concurrently on Postgres", () => {
    redirectHome();
    mkdirSync(join(tmp, ".gbrain"), { recursive: true });
    writeFileSync(join(tmp, ".gbrain", "config.json"), JSON.stringify({ engine: "postgres" }));
    expect(acquireDreamMarker(sourceA)).toBe(true);
    expect(acquireDreamMarker(sourceB)).toBe(true);
    expect(dreamMarkerPath(sourceA)).not.toBe(dreamMarkerPath(sourceB));
  });

  it("release removes the marker (same pid)", () => {
    redirectHome();
    expect(acquireDreamMarker(sourceA)).toBe(true);
    releaseDreamMarker(sourceA);
    expect(existsSync(dreamMarkerPath(sourceA))).toBe(false);
  });

  it("a stale marker (older than TTL) is taken over", () => {
    redirectHome();
    // Plant a marker with an mtime ~46 min in the past (TTL is 45 min).
    const path = dreamMarkerPath(sourceA);
    writeFileSync(path, JSON.stringify({ pid: 999999, started_at: "old" }));
    const old = new Date(Date.now() - 46 * 60 * 1000);
    utimesSync(path, old, old);
    expect(acquireDreamMarker(sourceA)).toBe(true); // takeover
    expect(existsSync(path)).toBe(true);
  });
});

describe("CLI gate wiring (dry-run subprocess — never spawns a real dream)", () => {
  // NOTE: we only pass --dry-run (optionally + --dream). We must NOT pass
  // --full here: parseArgs is last-mode-wins, so `--dry-run --full` resolves to
  // mode=full and would run a REAL ~minutes full sync + reindex. The --full
  // auto-chain gate is covered purely by the shouldRunDream matrix above.
  function run(extra: string[]): string {
    const r = spawnSync("bun", [SCRIPT, "--dry-run", ...extra], {
      encoding: "utf-8",
      timeout: 60000,
      env: { ...process.env },
    });
    return (r.stdout || "") + (r.stderr || "");
  }

  it("--dry-run --dream shows the source-scoped backfill preview row", () => {
    expect(run(["--dream"])).toContain("would: gbrain edges-backfill");
  });

  it("plain --dry-run (incremental) omits the dream row", () => {
    expect(run([])).not.toContain("would: gbrain edges-backfill");
  });
});

describe("skill readiness source custody", () => {
  it("passes the portable state root from the skill to the orchestrator writer", () => {
    const template = readFileSync(join(import.meta.dir, "..", "sync-gbrain", "SKILL.md.tmpl"), "utf-8");
    const runStep = template.slice(
      template.indexOf("## Step 2: Run the orchestrator"),
      template.indexOf("## Step 3: Code-index health check"),
    );
    expect(runStep).toContain('eval "$(~/.claude/skills/gstack/bin/gstack-paths)"');
    expect(runStep).toContain('GSTACK_STATE_ROOT="$GSTACK_STATE_ROOT"');
  });

  it("resolves code-index state through the portable root for this repository", () => {
    const template = readFileSync(join(import.meta.dir, "..", "sync-gbrain", "SKILL.md.tmpl"), "utf-8");
    const healthCheck = template.slice(
      template.indexOf("## Step 3: Code-index health check"),
      template.indexOf("## Step 3.5: Call-graph health check"),
    );
    expect(healthCheck).toContain('eval "$(~/.claude/skills/gstack/bin/gstack-paths)"');
    expect(healthCheck).toContain('.name=="code" and .detail.source_path==$path');
    expect(healthCheck).toContain('"$GSTACK_STATE_ROOT/.gbrain-sync-state.json"');
    expect(healthCheck).not.toContain("~/.gstack/.gbrain-sync-state.json");
  });

  it("uses the persisted path-validated dream/code source, never a raw cwd pin", () => {
    const template = readFileSync(join(import.meta.dir, "..", "sync-gbrain", "SKILL.md.tmpl"), "utf-8");
    const healthCheck = template.slice(
      template.indexOf("## Step 3.5: Call-graph health check"),
      template.indexOf("## Step 4: Refresh"),
    );
    expect(healthCheck).toContain('.name=="dream" and .detail.source_path==$path');
    expect(healthCheck).toContain('.name=="code" and .detail.source_path==$path');
    expect(healthCheck).toContain('.detail.source_path==$path');
    expect(healthCheck).toContain('eval "$(~/.claude/skills/gstack/bin/gstack-paths)"');
    expect(healthCheck).toContain('"$GSTACK_STATE_ROOT/.gbrain-sync-state.json"');
    expect(healthCheck).not.toContain('${GSTACK_HOME:-$HOME/.gstack}');
    expect(healthCheck).not.toContain("cat .gbrain-source");
  });
});

const SOURCE_ID = "gstack-code-candor-eda9672b";

function backfill(overrides: Partial<EdgeBackfillSummary> = {}): EdgeBackfillSummary {
  return {
    source_id: SOURCE_ID,
    chunks_walked: 2000,
    edges_resolved: 42,
    edges_ambiguous: 3,
    edges_unmatched: 7,
    batches: 10,
    ms: 500,
    ...overrides,
  };
}

function readiness(overrides: Partial<CallGraphReadiness> = {}): CallGraphReadiness {
  return {
    source_id: SOURCE_ID,
    scope: "single",
    count: 0,
    status: "ready",
    ready: true,
    ...overrides,
  };
}

describe("parseEdgeBackfillSummary — exact-source custody", () => {
  it("accepts the one row for the requested source", () => {
    const out = JSON.stringify({ schema_version: 1, summary: [backfill()] });
    expect(parseEdgeBackfillSummary(out, SOURCE_ID)).toEqual(backfill());
  });

  it("rejects another source, multiple rows, malformed JSON, and invalid counters", () => {
    expect(parseEdgeBackfillSummary(JSON.stringify({
      summary: [backfill({ source_id: "other-source" })],
    }), SOURCE_ID)).toBeNull();
    expect(parseEdgeBackfillSummary(JSON.stringify({
      summary: [backfill(), backfill({ source_id: "other-source" })],
    }), SOURCE_ID)).toBeNull();
    expect(parseEdgeBackfillSummary("not-json", SOURCE_ID)).toBeNull();
    expect(parseEdgeBackfillSummary(JSON.stringify({
      summary: [backfill({ chunks_walked: -1 })],
    }), SOURCE_ID)).toBeNull();
  });
});

describe("parseCallGraphReadiness — exact-source public signal", () => {
  it("accepts a zero-result sentinel envelope that says the source is ready", () => {
    expect(parseCallGraphReadiness(JSON.stringify(readiness()), SOURCE_ID)).toEqual(readiness());
  });

  it("rejects global, wrong-source, colliding-sentinel, and malformed evidence", () => {
    expect(parseCallGraphReadiness(JSON.stringify({
      ...readiness(),
      scope: "all",
    }), SOURCE_ID)).toBeNull();
    expect(parseCallGraphReadiness(JSON.stringify({
      ...readiness(),
      source_id: "other-source",
    }), SOURCE_ID)).toBeNull();
    expect(parseCallGraphReadiness(JSON.stringify({
      ...readiness(),
      count: 1,
    }), SOURCE_ID)).toBeNull();
    expect(parseCallGraphReadiness("not-json", SOURCE_ID)).toBeNull();
  });
});

describe("nextCallGraphPass — bounded official batching", () => {
  it("stops only on source-scoped ready=true", () => {
    expect(nextCallGraphPass(backfill(), readiness())).toBe("ready");
  });

  it("continues indexing only when the official batch made progress", () => {
    expect(nextCallGraphPass(
      backfill({ chunks_walked: 2000 }),
      readiness({ status: "indexing", ready: false }),
    )).toBe("continue");
    expect(nextCallGraphPass(
      backfill({ chunks_walked: 0 }),
      readiness({ status: "indexing", ready: false }),
    )).toBe("stalled");
  });

  it("fails closed on not-built, unknown, and contradictory readiness", () => {
    expect(nextCallGraphPass(
      backfill({ chunks_walked: 0 }),
      readiness({ status: "not_built", ready: false }),
    )).toBe("not_built");
    expect(nextCallGraphPass(
      backfill({ chunks_walked: 0 }),
      readiness({ status: "unknown", ready: false }),
    )).toBe("unknown");
    expect(nextCallGraphPass(
      backfill(),
      readiness({ status: "indexing", ready: true }),
    )).toBe("invalid");
  });
});

describe("formatStage — WARN render", () => {
  const base = { name: "dream", duration_ms: 0, summary: "x" };
  it("renders WARN for a ran+ok+warn stage (degraded no-op)", () => {
    expect(formatStage({ ...base, ran: true, ok: true, warn: true })).toContain("WARN");
  });
  it("renders OK for a ran+ok stage without warn", () => {
    const s = formatStage({ ...base, ran: true, ok: true });
    expect(s).toContain("OK");
    expect(s).not.toContain("WARN");
  });
  it("renders ERR for a ran+!ok stage even if warn is set", () => {
    expect(formatStage({ ...base, ran: true, ok: false, warn: true })).toContain("ERR");
  });
  it("renders SKIP for a !ran stage", () => {
    expect(formatStage({ ...base, ran: false, ok: true })).toContain("SKIP");
  });
});
