#!/usr/bin/env bun
/**
 * gstack-gbrain-sync — V1 unified sync verb.
 *
 * Orchestrates three storage tiers per plan §"Storage tiering":
 *
 *   1. Code (current repo)         → `gbrain sources add` (idempotent via
 *                                    lib/gbrain-sources.ts) + `gbrain sync
 *                                    --strategy code` (incremental) or
 *                                    `gbrain reindex-code --yes` (--full).
 *                                    NEVER `gbrain import` (markdown only).
 *   2. Transcripts + curated memory → gstack-memory-ingest (typed put_page)
 *   3. Curated artifacts to git    → gstack-brain-sync (existing pipeline)
 *
 * Modes:
 *   --incremental (default) — mtime fast-path; runs all 3 stages with cache hits
 *   --full                  — first-run; full walk + reindex; honest budget per ED2
 *   --dry-run               — preview what would sync; no writes anywhere (incl. state file)
 *
 * Concurrency safety per /plan-eng-review D1:
 *   - Lock file at ~/.gstack/.sync-gbrain.lock (PID + start ts).
 *   - Stale-lock takeover after 5 min (process death).
 *   - State file written via tmp+rename for atomicity.
 *   - Lock released in finally; SIGINT/SIGTERM trapped for cleanup.
 *
 * --watch (V1.5 P0 TODO): file-watcher daemon. NOTE: gbrain v0.25.1 already
 * ships `gbrain sync --watch [--interval N]` and `gbrain sync --install-cron`;
 * when revisited, /sync-gbrain --watch wires through to the gbrain CLI rather
 * than building a gstack-side daemon.
 */

import { existsSync, statSync, mkdirSync, writeFileSync, readFileSync, unlinkSync, renameSync } from "fs";
import { join, dirname } from "path";
import { execSync, spawnSync } from "child_process";
import { homedir } from "os";
import { createHash } from "crypto";

import { detectEngineTier, withErrorContext, canonicalizeRemote } from "../lib/gstack-memory-helpers";
import { ensureSourceRegistered, sourcePageCount } from "../lib/gbrain-sources";

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

interface CodeStageDetail {
  source_id?: string;
  source_path?: string;
  page_count?: number | null;
  last_imported?: string;
  status?: "ok" | "skipped" | "failed";
}

interface StageResult {
  name: string;
  ran: boolean;
  ok: boolean;
  duration_ms: number;
  summary: string;
  /** Stage-specific structured detail. Code stage carries source_id + page_count. */
  detail?: CodeStageDetail;
}

// ── Constants ──────────────────────────────────────────────────────────────

const HOME = homedir();
const GSTACK_HOME = process.env.GSTACK_HOME || join(HOME, ".gstack");
const STATE_PATH = join(GSTACK_HOME, ".gbrain-sync-state.json");
const LOCK_PATH = join(GSTACK_HOME, ".sync-gbrain.lock");
const STALE_LOCK_MS = 5 * 60 * 1000;

// ── CLI ────────────────────────────────────────────────────────────────────

function printUsage(): void {
  console.error(`Usage: gstack-gbrain-sync [--incremental|--full|--dry-run] [options]

Modes:
  --incremental        Default. mtime fast-path; ~50ms steady-state.
  --full               First-run; full walk + reindex. Honest ~25-35 min for big Macs (ED2).
  --dry-run            Preview what would sync; no writes anywhere.

Options:
  --quiet              Suppress per-stage output.
  --no-code            Skip the cwd code-import stage.
  --no-memory          Skip the gstack-memory-ingest stage (transcripts + artifacts).
  --no-brain-sync      Skip the gstack-brain-sync git pipeline stage.
  --code-only          Only run the code-import stage (alias for --no-memory --no-brain-sync).
  --help               This text.

Stages run in order: code → memory ingest → curated git push.
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

// ── Helpers ────────────────────────────────────────────────────────────────

function repoRoot(): string | null {
  try {
    const out = execSync("git rev-parse --show-toplevel", { encoding: "utf-8", timeout: 2000 });
    return out.trim();
  } catch {
    return null;
  }
}

function originUrl(): string | null {
  try {
    const out = execSync("git remote get-url origin", { encoding: "utf-8", timeout: 2000 });
    return out.trim();
  } catch {
    return null;
  }
}

/**
 * Derive a worktree-aware source id for the cwd code corpus.
 *
 * Pattern: `gstack-code-<slug>-<pathhash8>` where slug comes from origin
 * (org/repo) and pathhash8 is the first 8 hex chars of sha1(absolute repo
 * path). The pathhash8 is what makes Conductor worktrees of the same repo
 * coexist as separate sources in the same gbrain DB instead of stomping on
 * each other.
 *
 * Falls back to the repo basename when there is no origin (local repo).
 *
 * gbrain enforces source ids to be 1-32 lowercase alnum chars with
 * optional interior hyphens. `constrainSourceId` handles the 32-char cap
 * with a hashed-tail fallback when the combined slug exceeds budget.
 */
function deriveCodeSourceId(repoPath: string): string {
  const pathHash = createHash("sha1").update(repoPath).digest("hex").slice(0, 8);
  const remote = canonicalizeRemote(originUrl());
  if (remote) {
    const segs = remote.split("/").filter(Boolean);
    const slugSource = segs.slice(-2).join("-");
    return constrainSourceId("gstack-code", `${slugSource}-${pathHash}`);
  }
  const base = repoPath.split("/").pop() || "repo";
  return constrainSourceId("gstack-code", `${base}-${pathHash}`);
}

/**
 * Pre-pathhash source id, kept for orphan detection only.
 *
 * Earlier /sync-gbrain versions registered `gstack-code-<slug>` (no pathhash
 * suffix). On a multi-worktree repo, those collapsed onto a single source id
 * with last-sync-wins semantics. The new path-keyed id leaves the legacy
 * source orphaned in the brain — federated cross-source search would return
 * stale duplicate hits. We remove the legacy id once, on the first new-format
 * sync from any worktree of this repo, so users don't accumulate orphans.
 */
function deriveLegacyCodeSourceId(repoPath: string): string {
  const remote = canonicalizeRemote(originUrl());
  if (remote) {
    const segs = remote.split("/").filter(Boolean);
    const slugSource = segs.slice(-2).join("-");
    return constrainSourceId("gstack-code", slugSource);
  }
  const base = repoPath.split("/").pop() || "repo";
  return constrainSourceId("gstack-code", base);
}

/**
 * Build a gbrain-valid source id (1-32 lowercase alnum + interior hyphens). Sanitizes
 * `raw`, prefixes with `prefix`, and falls back to a hashed-tail form when total length
 * would exceed 32 chars.
 */
function constrainSourceId(prefix: string, raw: string): string {
  const MAX = 32;
  const slug = raw.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  // Empty slug after sanitize (e.g. raw was all non-alnum like "___") would
  // produce "${prefix}-" which fails gbrain's validator on the trailing
  // hyphen. Fall back to a deterministic hash of the original input so the
  // result is stable across runs of the same repo.
  if (!slug) {
    const hash = createHash("sha1").update(raw || "_empty").digest("hex").slice(0, 6);
    return `${prefix}-${hash}`;
  }
  const full = `${prefix}-${slug}`;
  if (full.length <= MAX) return full;
  const hash = createHash("sha1").update(slug).digest("hex").slice(0, 6);
  // Total budget: prefix + "-" + tail + "-" + hash
  const tailBudget = MAX - prefix.length - 2 - hash.length;
  if (tailBudget < 1) return `${prefix}-${hash}`;
  const tail = slug.slice(-tailBudget).replace(/^-+|-+$/g, "");
  return tail ? `${prefix}-${tail}-${hash}` : `${prefix}-${hash}`;
}

function gbrainAvailable(): boolean {
  try {
    execSync("command -v gbrain", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// ── Lock file (D1) ─────────────────────────────────────────────────────────

interface LockInfo {
  pid: number;
  started_at: string;
}

function acquireLock(): boolean {
  mkdirSync(GSTACK_HOME, { recursive: true });
  if (existsSync(LOCK_PATH)) {
    // Check if stale.
    try {
      const stat = statSync(LOCK_PATH);
      const ageMs = Date.now() - stat.mtimeMs;
      if (ageMs > STALE_LOCK_MS) {
        // Stale; take over.
        unlinkSync(LOCK_PATH);
      } else {
        return false;
      }
    } catch {
      // Cannot stat; bail conservatively.
      return false;
    }
  }
  const info: LockInfo = { pid: process.pid, started_at: new Date().toISOString() };
  try {
    writeFileSync(LOCK_PATH, JSON.stringify(info), { encoding: "utf-8", flag: "wx" });
    return true;
  } catch {
    return false;
  }
}

function releaseLock(): void {
  try {
    if (!existsSync(LOCK_PATH)) return;
    const raw = readFileSync(LOCK_PATH, "utf-8");
    const info = JSON.parse(raw) as LockInfo;
    if (info.pid === process.pid) {
      unlinkSync(LOCK_PATH);
    }
  } catch {
    // Best-effort cleanup.
  }
}

// ── Stage runners ──────────────────────────────────────────────────────────

async function runCodeImport(args: CliArgs): Promise<StageResult> {
  const t0 = Date.now();
  const root = repoRoot();
  if (!root) {
    return { name: "code", ran: false, ok: true, duration_ms: 0, summary: "skipped (not in git repo)" };
  }
  if (!gbrainAvailable()) {
    return { name: "code", ran: false, ok: false, duration_ms: 0, summary: "skipped (gbrain CLI not in PATH)" };
  }

  const sourceId = deriveCodeSourceId(root);

  if (args.mode === "dry-run") {
    return {
      name: "code",
      ran: false,
      ok: true,
      duration_ms: 0,
      summary: `would: gbrain sources add ${sourceId} --path ${root} --federated; gbrain sync --strategy code --source ${sourceId}; gbrain sources attach ${sourceId}`,
      detail: { source_id: sourceId, source_path: root, status: "skipped" },
    };
  }

  // Step 0: Best-effort cleanup of pre-pathhash legacy source.
  // Earlier /sync-gbrain versions registered `gstack-code-<slug>` (no path
  // suffix). On a multi-worktree repo, those collapsed onto a single id
  // with last-sync-wins. Federated search would return stale duplicate
  // hits forever if we left the orphan in place. Remove the legacy id once
  // here so users don't accumulate orphans.
  // Failure is non-fatal — we still register the new id below.
  const legacyId = deriveLegacyCodeSourceId(root);
  let legacyRemoved = false;
  if (legacyId !== sourceId) {
    const rm = spawnSync("gbrain", ["sources", "remove", legacyId, "--confirm-destructive"], {
      encoding: "utf-8",
      timeout: 30_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    // Treat absent-source as success (clean state). gbrain emits "not found" on
    // missing id; treat any non-zero exit without "not found" as a soft fail.
    if (rm.status === 0) legacyRemoved = true;
  }

  // Step 1: Ensure source registered (idempotent). Single source of truth in lib —
  // no synchronous duplicate here (per /codex review #12).
  let registered = false;
  try {
    const result = await ensureSourceRegistered(sourceId, root, { federated: true });
    registered = result.changed;
  } catch (err) {
    return {
      name: "code",
      ran: true,
      ok: false,
      duration_ms: Date.now() - t0,
      summary: `source registration failed: ${(err as Error).message}`,
      detail: { source_id: sourceId, source_path: root, status: "failed" },
    };
  }

  // Step 2: Run sync or reindex.
  const syncArgs = args.mode === "full"
    ? ["reindex-code", "--source", sourceId, "--yes"]
    : ["sync", "--strategy", "code", "--source", sourceId];

  const syncResult = spawnSync("gbrain", syncArgs, {
    stdio: args.quiet ? ["ignore", "ignore", "ignore"] : ["ignore", "inherit", "inherit"],
    timeout: 35 * 60 * 1000,
  });

  if (syncResult.status !== 0) {
    return {
      name: "code",
      ran: true,
      ok: false,
      duration_ms: Date.now() - t0,
      summary: `gbrain ${syncArgs.join(" ")} exited ${syncResult.status}`,
      detail: { source_id: sourceId, source_path: root, status: "failed" },
    };
  }

  // Step 3: Pin this worktree's CWD to the source via .gbrain-source. Subsequent
  // gbrain code-def / code-refs / code-callers calls from anywhere under <root>
  // route to this source by default — no --source flag needed.
  //
  // If attach fails the whole flow has a silent correctness problem: sync
  // succeeded but unqualified `gbrain code-def` from this worktree will hit
  // the wrong/default source. Treat it as a stage failure (ok=false) so the
  // verdict block surfaces ERR and the user knows to retry rather than
  // trusting stale results.
  const attach = spawnSync("gbrain", ["sources", "attach", sourceId], {
    encoding: "utf-8",
    timeout: 10_000,
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const pageCount = sourcePageCount(sourceId);
  const legacyNote = legacyRemoved ? `, removed legacy ${legacyId}` : "";
  const baseSummary = `${registered ? "registered + " : ""}synced ${sourceId} (page_count=${pageCount ?? "unknown"}${legacyNote})`;

  if (attach.status !== 0) {
    const reason = (attach.stderr || attach.stdout || "").trim().split("\n").pop() || `exit ${attach.status}`;
    return {
      name: "code",
      ran: true,
      ok: false,
      duration_ms: Date.now() - t0,
      summary: `${baseSummary}; attach FAILED (${reason}) — code-def queries from this worktree will hit the default source until /sync-gbrain succeeds`,
      detail: {
        source_id: sourceId,
        source_path: root,
        page_count: pageCount,
        last_imported: new Date().toISOString(),
        status: "failed",
      },
    };
  }

  return {
    name: "code",
    ran: true,
    ok: true,
    duration_ms: Date.now() - t0,
    summary: baseSummary,
    detail: {
      source_id: sourceId,
      source_path: root,
      page_count: pageCount,
      last_imported: new Date().toISOString(),
      status: "ok",
    },
  };
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
    timeout: 35 * 60 * 1000,
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

  const brainSyncPath = join(import.meta.dir, "gstack-brain-sync");
  if (!existsSync(brainSyncPath)) {
    return { name: "brain-sync", ran: false, ok: true, duration_ms: 0, summary: "skipped (gstack-brain-sync not installed)" };
  }

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

// ── State file ─────────────────────────────────────────────────────────────

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

/**
 * Atomic state file write per /plan-eng-review D1: write tmp file then rename.
 * rename(2) is atomic on POSIX filesystems.
 */
function saveSyncState(state: SyncState): void {
  try {
    mkdirSync(dirname(STATE_PATH), { recursive: true });
    const tmp = `${STATE_PATH}.tmp.${process.pid}`;
    writeFileSync(tmp, JSON.stringify(state, null, 2), "utf-8");
    renameSync(tmp, STATE_PATH);
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

  // Acquire lock (skip on dry-run since dry-run never writes).
  const needsLock = args.mode !== "dry-run";
  let haveLock = false;
  if (needsLock) {
    haveLock = acquireLock();
    if (!haveLock) {
      console.error(
        `[gbrain-sync] another /sync-gbrain is running (lock at ${LOCK_PATH}). ` +
        `If that process died, the lock auto-clears after 5 min, or remove it manually.`
      );
      process.exit(2);
    }
  }

  const cleanup = () => {
    if (haveLock) releaseLock();
  };
  process.on("SIGINT", () => { cleanup(); process.exit(130); });
  process.on("SIGTERM", () => { cleanup(); process.exit(143); });

  let exitCode = 0;
  try {
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
    exitCode = anyError ? 1 : 0;
  } finally {
    cleanup();
  }

  process.exit(exitCode);
}

main().catch((err) => {
  console.error(`gstack-gbrain-sync fatal: ${err instanceof Error ? err.message : String(err)}`);
  releaseLock();
  process.exit(1);
});
