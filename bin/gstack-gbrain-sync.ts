#!/usr/bin/env bun
/**
 * gstack-gbrain-sync — V1 unified sync verb.
 *
 * Orchestrates three storage tiers per plan §"Storage tiering":
 *
 *   1. Code (current repo)         → gbrain import (Supabase or local PGLite)
 *   2. Transcripts + curated memory → gstack-memory-ingest (typed put_page)
 *   3. Curated artifacts to git    → gstack-brain-sync (existing pipeline)
 *
 * Modes:
 *   --incremental (default) — mtime fast-path; runs all 3 stages with cache hits
 *   --full                  — first-run; full walk + import; honest budget per ED2
 *   --dry-run               — preview what would sync; no writes
 *
 * --watch (V1.5 P0 TODO): file-watcher daemon. Deferred per Codex F3 ("no daemon"
 * invariant). For V1, continuous sync rides the preamble-boundary hook only.
 *
 * Cross-repo TODO (V1.5): when gbrain CLI ships `put_file` + `restore-from-sync`,
 * this helper picks them up via version probe (Codex F6 + D9) and routes
 * code/transcripts to Supabase Storage instead of put_page.
 */

import { existsSync, statSync, mkdirSync, writeFileSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { execSync, spawnSync } from "child_process";
import { homedir } from "os";

import { detectEngineTier, withErrorContext } from "../lib/gstack-memory-helpers";

// ── Types ──────────────────────────────────────────────────────────────────

type Mode = "incremental" | "full" | "dry-run";

interface CliArgs {
  mode: Mode;
  quiet: boolean;
  noCode: boolean;
  noMemory: boolean;
  noBrainSync: boolean;
  codeOnly: boolean;
}

interface StageResult {
  name: string;
  ran: boolean;
  ok: boolean;
  duration_ms: number;
  summary: string;
}

// ── Constants ──────────────────────────────────────────────────────────────

const HOME = homedir();
const GSTACK_HOME = process.env.GSTACK_HOME || join(HOME, ".gstack");
const STATE_PATH = join(GSTACK_HOME, ".gbrain-sync-state.json");

// ── CLI ────────────────────────────────────────────────────────────────────

function printUsage(): void {
  console.error(`Usage: gstack-gbrain-sync [--incremental|--full|--dry-run] [options]

Modes:
  --incremental        Default. mtime fast-path; ~50ms steady-state.
  --full               First-run; full walk + import. Honest ~25-35 min for big Macs (ED2).
  --dry-run            Preview what would sync; no writes.

Options:
  --quiet              Suppress per-stage output.
  --no-code            Skip the gbrain import (current repo) stage.
  --no-memory          Skip the gstack-memory-ingest stage (transcripts + artifacts).
  --no-brain-sync      Skip the gstack-brain-sync git pipeline stage.
  --code-only          Only run the gbrain import stage (alias for --no-memory --no-brain-sync).
  --help               This text.

Stages run in order: code import → memory ingest → curated git push.
Each stage failure is non-fatal; subsequent stages still run.
`);
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  let mode: Mode = "incremental";
  let quiet = false;
  let noCode = false;
  let noMemory = false;
  let noBrainSync = false;
  let codeOnly = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    switch (a) {
      case "--incremental": mode = "incremental"; break;
      case "--full": mode = "full"; break;
      case "--dry-run": mode = "dry-run"; break;
      case "--quiet": quiet = true; break;
      case "--no-code": noCode = true; break;
      case "--no-memory": noMemory = true; break;
      case "--no-brain-sync": noBrainSync = true; break;
      case "--code-only":
        codeOnly = true;
        noMemory = true;
        noBrainSync = true;
        break;
      case "--help":
      case "-h":
        printUsage();
        process.exit(0);
      default:
        console.error(`Unknown argument: ${a}`);
        printUsage();
        process.exit(1);
    }
  }

  return { mode, quiet, noCode, noMemory, noBrainSync, codeOnly };
}

// ── Stage runners ──────────────────────────────────────────────────────────

function repoRoot(): string | null {
  try {
    const out = execSync("git rev-parse --show-toplevel", { encoding: "utf-8", timeout: 2000 });
    return out.trim();
  } catch {
    return null;
  }
}

function gbrainAvailable(): boolean {
  try {
    execSync("command -v gbrain", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function runCodeImport(args: CliArgs): StageResult {
  const t0 = Date.now();
  const root = repoRoot();
  if (!root) {
    return { name: "code", ran: false, ok: true, duration_ms: 0, summary: "skipped (not in git repo)" };
  }
  if (!gbrainAvailable()) {
    return { name: "code", ran: false, ok: false, duration_ms: 0, summary: "skipped (gbrain CLI not in PATH)" };
  }
  if (args.mode === "dry-run") {
    return { name: "code", ran: false, ok: true, duration_ms: 0, summary: `would: gbrain import ${root} --no-embed` };
  }

  const importArgs = ["import", root, "--no-embed"];
  if (args.mode === "incremental") {
    // gbrain import is itself idempotent on re-import; --incremental flag if it supports
    importArgs.push("--incremental");
  }

  try {
    spawnSync("gbrain", importArgs, {
      stdio: args.quiet ? ["ignore", "ignore", "ignore"] : ["ignore", "inherit", "inherit"],
      timeout: 5 * 60 * 1000,
    });
    // Trigger background embedding catch-up
    spawnSync("gbrain", ["embed", "--stale"], {
      stdio: ["ignore", "ignore", "ignore"],
      timeout: 1000, // background spawn; don't wait
    });
    return {
      name: "code",
      ran: true,
      ok: true,
      duration_ms: Date.now() - t0,
      summary: `imported ${root}`,
    };
  } catch (err) {
    return {
      name: "code",
      ran: true,
      ok: false,
      duration_ms: Date.now() - t0,
      summary: `gbrain import failed: ${(err as Error).message}`,
    };
  }
}

function runMemoryIngest(args: CliArgs): StageResult {
  const t0 = Date.now();

  if (args.mode === "dry-run") {
    return { name: "memory", ran: false, ok: true, duration_ms: 0, summary: "would: gstack-memory-ingest --probe" };
  }

  const ingestPath = join(import.meta.dir, "gstack-memory-ingest.ts");
  const ingestArgs = ["run", ingestPath];
  if (args.mode === "full") ingestArgs.push("--bulk");
  else ingestArgs.push("--incremental");
  if (args.quiet) ingestArgs.push("--quiet");

  const result = spawnSync("bun", ingestArgs, {
    encoding: "utf-8",
    timeout: 35 * 60 * 1000, // honest 35-min ceiling per ED2
  });

  const summary = (result.stderr || "").split("\n").filter((l) => l.includes("[memory-ingest]")).slice(-1)[0] || "ingest pass complete";

  return {
    name: "memory",
    ran: true,
    ok: result.status === 0,
    duration_ms: Date.now() - t0,
    summary: result.status === 0 ? summary : `memory ingest exited ${result.status}`,
  };
}

function runBrainSyncPush(args: CliArgs): StageResult {
  const t0 = Date.now();

  if (args.mode === "dry-run") {
    return { name: "brain-sync", ran: false, ok: true, duration_ms: 0, summary: "would: gstack-brain-sync --discover-new --once" };
  }

  const brainSyncPath = join(HOME, ".claude", "skills", "gstack", "bin", "gstack-brain-sync");
  if (!existsSync(brainSyncPath)) {
    return { name: "brain-sync", ran: false, ok: true, duration_ms: 0, summary: "skipped (gstack-brain-sync not installed)" };
  }

  // Discover new artifacts then drain queue
  spawnSync(brainSyncPath, ["--discover-new"], {
    stdio: args.quiet ? ["ignore", "ignore", "ignore"] : ["ignore", "inherit", "inherit"],
    timeout: 60 * 1000,
  });
  const result = spawnSync(brainSyncPath, ["--once"], {
    stdio: args.quiet ? ["ignore", "ignore", "ignore"] : ["ignore", "inherit", "inherit"],
    timeout: 60 * 1000,
  });

  return {
    name: "brain-sync",
    ran: true,
    ok: result.status === 0,
    duration_ms: Date.now() - t0,
    summary: result.status === 0 ? "curated artifacts pushed" : `gstack-brain-sync exited ${result.status}`,
  };
}

// ── State file (records last sync timestamp + stage outcomes) ──────────────

interface SyncState {
  schema_version: 1;
  last_writer: string;
  last_sync?: string;
  last_full_sync?: string;
  last_stages?: StageResult[];
}

function loadSyncState(): SyncState {
  if (!existsSync(STATE_PATH)) {
    return { schema_version: 1, last_writer: "gstack-gbrain-sync" };
  }
  try {
    const raw = JSON.parse(readFileSync(STATE_PATH, "utf-8")) as SyncState;
    if (raw.schema_version === 1) return raw;
  } catch {
    // fall through
  }
  return { schema_version: 1, last_writer: "gstack-gbrain-sync" };
}

function saveSyncState(state: SyncState): void {
  try {
    mkdirSync(dirname(STATE_PATH), { recursive: true });
    writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), "utf-8");
  } catch {
    // non-fatal
  }
}

// ── Output ─────────────────────────────────────────────────────────────────

function formatStage(s: StageResult): string {
  const status = !s.ran ? "SKIP" : s.ok ? "OK" : "ERR";
  const dur = s.duration_ms > 0 ? ` (${(s.duration_ms / 1000).toFixed(1)}s)` : "";
  return `  ${status.padEnd(5)} ${s.name.padEnd(12)} ${s.summary}${dur}`;
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs();

  if (!args.quiet) {
    const engine = detectEngineTier();
    console.error(`[gbrain-sync] mode=${args.mode} engine=${engine.engine}`);
  }

  const state = loadSyncState();
  const stages: StageResult[] = [];

  if (!args.noCode) {
    stages.push(await withErrorContext("sync:code", () => runCodeImport(args), "gstack-gbrain-sync"));
  }
  if (!args.noMemory) {
    stages.push(await withErrorContext("sync:memory", () => runMemoryIngest(args), "gstack-gbrain-sync"));
  }
  if (!args.noBrainSync) {
    stages.push(await withErrorContext("sync:brain-sync", () => runBrainSyncPush(args), "gstack-gbrain-sync"));
  }

  // Persist state (skip on dry-run)
  if (args.mode !== "dry-run") {
    state.last_sync = new Date().toISOString();
    if (args.mode === "full") state.last_full_sync = state.last_sync;
    state.last_stages = stages;
    saveSyncState(state);
  }

  if (!args.quiet || args.mode === "dry-run") {
    console.log(`\ngstack-gbrain-sync (${args.mode}):`);
    for (const s of stages) console.log(formatStage(s));
    const okCount = stages.filter((s) => s.ok).length;
    const errCount = stages.filter((s) => !s.ok && s.ran).length;
    console.log(`\n  ${okCount} ok, ${errCount} error, ${stages.length - okCount - errCount} skipped`);
  }

  const anyError = stages.some((s) => s.ran && !s.ok);
  process.exit(anyError ? 1 : 0);
}

main().catch((err) => {
  console.error(`gstack-gbrain-sync fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
