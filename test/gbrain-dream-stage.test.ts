/**
 * Tests for the dream (call-graph build) stage of bin/gstack-gbrain-sync.ts.
 *
 * We deliberately do NOT exercise the real `gbrain dream` spawn here — that's a
 * ~35-min brain-global job and must never run in CI. Instead we cover:
 *   1. shouldRunDream() — the pure gate matrix (issues 1/2/4). Highest-risk logic.
 *   2. runDream() dry-run — returns a preview before any engine probe / spawn.
 *   3. Dream marker (acquire/release/stale-takeover) — the concurrency guard.
 *   4. CLI gate wiring via --dry-run subprocess (safe: dry-run never spawns dream).
 *
 * The live spawn + lock-free ordering + serialization are covered by the manual
 * E2E verification in the plan (running the orchestrator against a real brain),
 * not by a unit test that could launch a real dream.
 */

import { describe, it, expect, afterEach } from "bun:test";
import { mkdtempSync, existsSync, writeFileSync, utimesSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawnSync } from "child_process";

import {
  shouldRunDream,
  runDream,
  acquireDreamMarker,
  releaseDreamMarker,
  dreamMarkerPath,
  classifyDreamOutcome,
  parseResolvedEdges,
  formatStage,
  type CliArgs,
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

  it("--full auto-runs ONLY when the cycle was never built", () => {
    expect(shouldRunDream(args({ mode: "full" }), "never")).toBe(true);
    expect(shouldRunDream(args({ mode: "full" }), "completed")).toBe(false);
    expect(shouldRunDream(args({ mode: "full" }), "unknown")).toBe(false);
    expect(shouldRunDream(args({ mode: "full" }), null)).toBe(false);
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

describe("runDream — dry-run preview", () => {
  it("returns a 'would' preview without spawning (ran=false, ok=true)", async () => {
    const r = await runDream(args({ mode: "dry-run", dream: true }));
    expect(r.name).toBe("dream");
    expect(r.ran).toBe(false);
    expect(r.ok).toBe(true);
    expect(r.summary).toContain("would: gbrain dream");
  });
});

describe("dream marker — concurrency guard", () => {
  const saved = process.env.GSTACK_HOME;
  let tmp: string;

  afterEach(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    if (saved === undefined) delete process.env.GSTACK_HOME;
    else process.env.GSTACK_HOME = saved;
  });

  function redirectHome(): void {
    tmp = mkdtempSync(join(tmpdir(), "gbrain-dream-marker-"));
    process.env.GSTACK_HOME = tmp;
  }

  it("acquire creates the marker; a second acquire on a fresh marker fails", () => {
    redirectHome();
    expect(acquireDreamMarker()).toBe(true);
    expect(existsSync(dreamMarkerPath())).toBe(true);
    // Fresh marker present → a concurrent worktree must NOT launch a duplicate.
    expect(acquireDreamMarker()).toBe(false);
  });

  it("release removes the marker (same pid)", () => {
    redirectHome();
    expect(acquireDreamMarker()).toBe(true);
    releaseDreamMarker();
    expect(existsSync(dreamMarkerPath())).toBe(false);
  });

  it("a stale marker (older than TTL) is taken over", () => {
    redirectHome();
    // Plant a marker with an mtime ~46 min in the past (TTL is 45 min).
    const path = dreamMarkerPath();
    writeFileSync(path, JSON.stringify({ pid: 999999, started_at: "old" }));
    const old = new Date(Date.now() - 46 * 60 * 1000);
    utimesSync(path, old, old);
    expect(acquireDreamMarker()).toBe(true); // takeover
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

  it("--dry-run --dream shows the dream preview row", () => {
    expect(run(["--dream"])).toContain("would: gbrain dream");
  });

  it("plain --dry-run (incremental) omits the dream row", () => {
    expect(run([])).not.toContain("would: gbrain dream");
  });
});

// Canned `gbrain dream` cycle logs (verbatim shapes observed against a real
// 0.41.x brain). These let us test the post-flight guard WITHOUT a real cycle.
const LOG = {
  // Pack lacks the code-symbol phase: extract_atoms is undeclared AND the edge
  // resolver matches nothing. Both signals present — pack message must win.
  notCodeAware:
    "[cycle.extract] done\n" +
    "  - extract_atoms  extract_atoms: active pack does not declare this phase\n" +
    "[cycle.resolve_symbol_edges] start\n" +
    "[cycle.resolve_symbol_edges] done\n" +
    "  ✓ resolve_symbol_edges  3864 chunk(s) walked; resolved 0, ambiguous 0, unmatched 0\n" +
    "  totals: extracted=0 embedded=1\n",
  // Embed phase failed for a missing key (isolated: no pack-capability line).
  embedFailed:
    "[cycle.embed] start\n" +
    "[cycle.embed] done\n" +
    "  ✗ embed       embed phase failed\n" +
    '      [LLMError/UNKNOWN] Embedding model "openai:text-embedding-3-large" requires OPENAI_API_KEY.\n' +
    "  totals: extracted=0 embedded=0\n",
  // Cycle ran clean but matched zero edges (no other failure signal).
  zeroEdges:
    "  ✓ resolve_symbol_edges  120 chunk(s) walked; resolved 0, ambiguous 0, unmatched 0\n",
  // Happy path: edges resolved.
  builtEdges:
    "  ✓ resolve_symbol_edges  500 chunk(s) walked; resolved 42, ambiguous 3, unmatched 1\n",
  // Old gbrain / different pack: no resolve_symbol_edges summary line at all.
  noEdgeLine: "[cycle.lint] done\n[cycle.sync] done\n  totals: lint=53\n",
};

describe("parseResolvedEdges", () => {
  it("reads the resolved count from the ✓ summary line", () => {
    expect(parseResolvedEdges(LOG.builtEdges)).toBe(42);
    expect(parseResolvedEdges(LOG.zeroEdges)).toBe(0);
  });
  it("returns null when there is no resolve_symbol_edges summary", () => {
    expect(parseResolvedEdges(LOG.noEdgeLine)).toBeNull();
  });
  it("does not match the bracketed [cycle.resolve_symbol_edges] marker lines", () => {
    // Markers have no 'resolved N' on the same line, so they must not match.
    const markersOnly = "[cycle.resolve_symbol_edges] start\n[cycle.resolve_symbol_edges] done\n";
    expect(parseResolvedEdges(markersOnly)).toBeNull();
  });
});

describe("classifyDreamOutcome — post-flight truth guard", () => {
  it("flags a non-code-aware schema pack (wins over the 0-edge signal)", () => {
    const w = classifyDreamOutcome(LOG.notCodeAware);
    expect(w).not.toBeNull();
    expect(w).toContain("schema pack");
    expect(w).toContain("code-aware");
  });

  it("flags a failed embed phase / missing embedding key", () => {
    const w = classifyDreamOutcome(LOG.embedFailed);
    expect(w).not.toBeNull();
    expect(w).toContain("embed");
    expect(w!.toLowerCase()).toContain("key");
  });

  it("flags a clean cycle that resolved 0 edges", () => {
    const w = classifyDreamOutcome(LOG.zeroEdges);
    expect(w).not.toBeNull();
    expect(w).toContain("0 call-graph edges");
  });

  it("returns null on the happy path (edges resolved)", () => {
    expect(classifyDreamOutcome(LOG.builtEdges)).toBeNull();
  });

  it("returns null when no recognizable signal is present (degrade to success)", () => {
    expect(classifyDreamOutcome(LOG.noEdgeLine)).toBeNull();
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
