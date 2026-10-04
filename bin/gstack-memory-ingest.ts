#!/usr/bin/env bun
/**
 * gstack-memory-ingest — V1 memory ingest helper.
 *
 * Walks coding-agent transcript sources + ~/.gstack/ curated artifacts and writes
 * each one to gbrain as a typed page. Per plan §"Storage tiering": curated memory
 * rides the existing gbrain Postgres + git pipeline; code/transcripts go to the
 * Supabase tier when configured (or local PGLite otherwise) — never double-store.
 *
 * Usage:
 *   gstack-memory-ingest --probe                 # count what would ingest, no writes
 *   gstack-memory-ingest --incremental [--quiet] # default; mtime fast-path; cheap
 *   gstack-memory-ingest --bulk [--all-history]  # first-run; full walk
 *   gstack-memory-ingest --bulk --benchmark      # time the bulk pass + report
 *   gstack-memory-ingest --include-unattributed  # also ingest sessions with no git remote
 *
 * Sources walked:
 *   ~/.claude/projects/<encoded-cwd>/<uuid>.jsonl   — Claude Code sessions
 *   ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl    — Codex CLI sessions
 *   ~/Library/Application Support/Cursor/User/*.vscdb — Cursor (V1.0.1 follow-up)
 *   ~/.gstack/projects/<slug>/learnings.jsonl       — typed: learning
 *   ~/.gstack/projects/<slug>/timeline.jsonl        — typed: timeline
 *   ~/.gstack/projects/<slug>/ceo-plans/*.md        — typed: ceo-plan
 *   ~/.gstack/projects/<slug>/*-design-*.md         — typed: design-doc
 *   ~/.gstack/analytics/eureka.jsonl                — typed: eureka
 *   ~/.gstack/builder-profile.jsonl                 — typed: builder-profile-entry
 *
 * State: ~/.gstack/.transcript-ingest-state.json (LOCAL per ED1, never synced).
 * Secret scanning: opt-in gitleaks over each rendered page via
 * lib/gstack-memory-helpers#secretScanText (D19).
 * Concurrent-write handling: partial-flag + re-ingest on next pass (D10).
 *
 * V1.0 NOTE: Cursor SQLite extraction is a V1.0.1 follow-up. The plan promoted it to
 * V1 scope, but full SQLite parsing requires a sqlite3 binary or library; deferred to
 * keep V1 ship-tight. See TODOS.md.
 *
 * V1.5 NOTE: When `gbrain put_file` ships in the gbrain CLI (cross-repo P0 TODO),
 * transcripts will route to Supabase Storage instead of the page-write path.
 * Until then, all content rides `gbrain put <slug>` (stdin, YAML frontmatter for
 * title/type/tags); gbrain's native dedup keys on session_id.
 */

import {
  existsSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  statSync,
  mkdirSync,
  mkdtempSync,
  appendFileSync,
  renameSync,
  openSync,
  readSync,
  closeSync,
  rmSync,
  realpathSync,
} from "fs";
import { join, basename, dirname, delimiter, relative } from "path";
import { execFileSync, spawnSync, spawn, type ChildProcess } from "child_process";
import { homedir } from "os";
import { createHash } from "crypto";

import {
  canonicalizeRemote,
  secretScanFile,
  secretScanText,
  detectEngineTier,
  withErrorContext,
} from "../lib/gstack-memory-helpers";
import { execGbrainText, gbrainConfigDir, spawnGbrain, spawnGbrainAsync } from "../lib/gbrain-exec";
import { constrainSourceId, parseSourcesList } from "../lib/gbrain-sources";
import {
  BISECT_AFTER_REFUSALS,
  DEFAULT_GET_CAP,
  DEFAULT_RECONCILE_LIMIT,
  LEGACY_SOURCE_ID,
  acquireStateLock,
  backupStateFile,
  checkLanding,
  classifyImport,
  formatReconcileSummary,
  gbrainLookups,
  isRetryable,
  loadStateFile,
  parseImportReport,
  reconcile,
  saveStateFile,
  setEntry,
  type BatchVerdict,
  type ImportReport,
  type IngestState,
  type LandingLookups,
  type StateEntry,
} from "../lib/memory-ingest-landing";
import { writeReceipt } from "../lib/egress-receipt";
import { checkOwnedStagingDir, STAGING_MARKER } from "../lib/staging-guard";
import { hasRepoPolicyStore, repoPolicyTierBatch } from "../lib/gbrain-repo-policy-client";
import { resolveStateRoot, mergedStateRoots, type StateRootEnv } from "../lib/state-root";
import {
  cutoffExclusion,
  purgeStagedTranscripts,
  readTranscriptConsent,
  repoExclusion,
  type TranscriptConsent,
  type TranscriptPolicy,
} from "../lib/transcript-consent";

// ── Types ──────────────────────────────────────────────────────────────────

type Mode = "probe" | "incremental" | "bulk" | "reconcile";

interface CliArgs {
  mode: Mode;
  quiet: boolean;
  benchmark: boolean;
  includeUnattributed: boolean;
  allHistory: boolean;
  sources: Set<MemoryType>;
  limit: number | null;
  noWrite: boolean;
  /** --reconcile --dry-run: report without changing state. */
  dryRun: boolean;
  /** --request-reconcile: record that a reconcile pass is pending (no gbrain calls). */
  requestReconcile: boolean;
  /**
   * Opt-in gitleaks scan of each rendered page during the prepare phase;
   * pages with findings, or that could not be scanned, are skipped. Off by
   * default — the cross-machine boundary (gstack-brain-sync, git push)
   * has its own scanner. Setting this adds ~4-8 min to cold runs.
   */
  scanSecrets: boolean;
}

type MemoryType =
  | "transcript"
  | "eureka"
  | "learning"
  | "timeline"
  | "ceo-plan"
  | "design-doc"
  | "retro"
  | "builder-profile-entry";

interface PageRecord {
  slug: string;
  title: string;
  type: MemoryType;
  agent?: "claude-code" | "codex" | "cursor";
  body: string;
  tags: string[];
  source_path: string;
  session_id?: string;
  cwd?: string;
  git_remote?: string;
  start_time?: string;
  end_time?: string;
  partial?: boolean;
  size_bytes: number;
  content_sha256: string;
}

interface ProbeReport {
  total_files: number;
  total_bytes: number;
  by_type: Record<MemoryType, { count: number; bytes: number }>;
  new_count: number;
  updated_count: number;
  unchanged_count: number;
  skipped_unattributed: number;
  /**
   * #2392 parity: transcripts whose remote's trust tier is `deny` /
   * `read-only`. Probe applies the SAME per-remote policy filter --bulk
   * applies, so its ingestible counts match what --bulk would write.
   */
  skipped_policy_deny: number;
  skipped_policy_readonly: number;
  /** Sessions a scoped consent (new@ cutoff, transcript_repos) kept out. */
  scope: TranscriptScopeCounts;
  estimate_minutes: number;
}

interface BulkResult {
  written: number;
  skipped_secret: number;
  skipped_dedup: number;
  skipped_unattributed: number;
  /**
   * #2392: transcripts skipped because their git remote's trust tier in
   * ~/.gstack/gbrain-repo-policy.json is `read-only` (search allowed, page
   * writes never — and transcript ingest writes pages).
   */
  skipped_policy_readonly: number;
  /** #2392: transcripts skipped because their remote's trust tier is `deny`. */
  skipped_policy_deny: number;
  failed: number;
  duration_ms: number;
  partial_pages: number;
  /** A1: pages gbrain refused or that were not found after import (retried next run). */
  refused?: number;
  /** A1: pages imported but not yet confirmed in the brain (checked on later runs). */
  unverified?: number;
  /** A1: pages isolated as poisoning their batch. */
  quarantined?: number;
  /** A4: transcript pages kept local (source not registered, or a remote brain for unattributed pages). */
  kept_local?: number;
  /** The pass returned before changing anything; the state file is not rewritten. */
  state_untouched?: boolean;
  /** Sessions a scoped consent kept out, and transcript pages selected. */
  scope?: TranscriptScopeCounts;
  /**
   * D6: when set, indicates a process-level failure (gbrain CLI missing
   * or `gbrain import` crashed). Per-file errors (FILE_TOO_LARGE etc.)
   * land in `failed` but do NOT set this flag — the orchestrator should
   * still treat the run as OK with summary mentioning the failure count.
   * Only when this is set does the verdict become ERR.
   */
  system_error?: string;
}

// ── Constants ──────────────────────────────────────────────────────────────

const HOME = homedir();
const GSTACK_HOME = resolveStateRoot();
const STATE_PATH = join(GSTACK_HOME, ".transcript-ingest-state.json");
const LOCK_PATH = `${STATE_PATH}.lock`;
/** Machine-local, never-federated source for --include-unattributed transcripts (A4). */
const UNATTRIBUTED_SOURCE_ID = "gstack-transcripts-unattributed";
const DEFAULT_INCREMENTAL_BUDGET_MS = 50;

const ALL_TYPES: MemoryType[] = [
  "transcript",
  "eureka",
  "learning",
  "timeline",
  "ceo-plan",
  "design-doc",
  "retro",
  "builder-profile-entry",
];

// ── Transcript consent ─────────────────────────────────────────────────────

export type { TranscriptConsent } from "../lib/transcript-consent";

let cachedConsent: TranscriptPolicy | null = null;

/**
 * Read transcript consent once per process across every merged state root
 * (lib/transcript-consent.ts). `recent`, `all` and `new@<time>` are consent;
 * an absent key, `off`, a legacy value (A-E, incremental) and anything
 * unrecognized are not. A cutoff or allowlist applies even under an explicit
 * `--sources transcript`. Pass `env` to bypass the per-process cache.
 */
function readIngestConsent(env?: StateRootEnv): TranscriptPolicy {
  if (!env && cachedConsent) return cachedConsent;
  const policy = readTranscriptConsent(mergedStateRoots(env ?? process.env));
  if (!env) cachedConsent = policy;
  return policy;
}

/** The consent fields without the contributing roots. */
export function normalizeTranscriptConsent(env?: StateRootEnv): TranscriptConsent {
  const { roots: _roots, ...consent } = readIngestConsent(env);
  return consent;
}

/** Sessions a scoped consent kept out of this run, by reason. */
export interface TranscriptScopeCounts {
  pre_cutoff: number;
  missing_start: number;
  not_allowlisted: number;
  /** Transcript pages this run selected for staging. */
  sessions_selected: number;
}

// ── CLI ────────────────────────────────────────────────────────────────────

function printUsage(): void {
  console.error(`Usage: gstack-memory-ingest [--probe|--incremental|--bulk|--reconcile] [options]

Modes:
  --probe              Count what would ingest; no writes. Fastest.
  --incremental        Default. mtime fast-path; only walks changed files.
  --bulk               First-run; full walk; gates on permission elsewhere.
  --reconcile          Re-check pages already marked ingested against the
                       brain and re-queue any that are missing, so lost
                       transcripts import again. Bounded (--limit, default
                       ${DEFAULT_RECONCILE_LIMIT}) and resumable; backs up the state file first.
                       With --dry-run it only reports.

Options:
  --quiet              Suppress per-file output (still prints summary).
  --benchmark          Time the run; report bytes-per-second + total.
  --include-unattributed  Ingest sessions with no resolvable git remote into the
                       machine-local, never-federated gbrain source
                       ${UNATTRIBUTED_SOURCE_ID}. Refused when the brain is
                       remote (Postgres or HTTP); such pages stay local.
  --all-history        Walk transcripts older than 90 days too.
  --sources <list>     Comma-separated subset: ${ALL_TYPES.join(",")}
                       Default: every type, minus transcript unless
                       transcript_ingest_mode is recent (90 days), all (all
                       history) or new@<UTC> (sessions started after it).
                       A list naming transcript overrides it; a new@ cutoff
                       and transcript_repos still apply.
  --limit <N>          Stop after N pages written (smoke testing). With
                       --reconcile: check at most N entries this pass.
  --dry-run            With --reconcile: report what would change, change nothing.
  --request-reconcile  Record that a reconcile pass is pending (no gbrain
                       calls); the next ingest run does one bounded pass.
  --no-write           Dry run: prepare pages and report counts, but import
                       nothing and leave the state file untouched.
  --scan-secrets       Opt-in gitleaks scan of outgoing rendered pages, including
                       resumed staging. Findings and incomplete scans block
                       writes and remain retryable. Off by default.
  --help               This text.
`);
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  let mode: Mode = "incremental";
  let quiet = false;
  let benchmark = false;
  let includeUnattributed = false;
  let allHistory = false;
  let limit: number | null = null;
  let sources: Set<MemoryType> = new Set(ALL_TYPES);
  let sourcesExplicit = false;
  let noWrite = process.env.GSTACK_MEMORY_INGEST_NO_WRITE === "1";
  let dryRun = false;
  let requestReconcile = false;
  let scanSecrets = process.env.GSTACK_MEMORY_INGEST_SCAN_SECRETS === "1";

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    switch (a) {
      case "--probe": mode = "probe"; break;
      case "--incremental": mode = "incremental"; break;
      case "--bulk": mode = "bulk"; break;
      case "--reconcile": mode = "reconcile"; break;
      case "--dry-run": dryRun = true; break;
      case "--request-reconcile": requestReconcile = true; break;
      case "--quiet": quiet = true; break;
      case "--benchmark": benchmark = true; break;
      case "--include-unattributed": includeUnattributed = true; break;
      case "--all-history": allHistory = true; break;
      case "--no-write": noWrite = true; break;
      case "--scan-secrets": scanSecrets = true; break;
      case "--limit":
        limit = parseInt(args[++i] || "0", 10);
        if (!Number.isFinite(limit) || limit <= 0) {
          console.error("--limit requires a positive integer");
          process.exit(1);
        }
        break;
      case "--sources": {
        const list = (args[++i] || "").split(",").map((s) => s.trim() as MemoryType);
        sources = new Set(list.filter((t) => ALL_TYPES.includes(t)));
        if (sources.size === 0) {
          console.error(`--sources must include at least one of: ${ALL_TYPES.join(",")}`);
          process.exit(1);
        }
        sourcesExplicit = true;
        break;
      }
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

  const consent = readIngestConsent();
  if (!sourcesExplicit && !consent.affirmative) {
    sources.delete("transcript");
    if (!quiet) {
      const why = consent.reason === "repos-unreadable" ? "; its +repos marker needs a transcript_repos allowlist" : "";
      console.error(`gstack-memory-ingest: transcripts skipped (transcript_ingest_mode=${consent.value ?? "not set"}${why}); set it to recent, all or new@<UTC time>, or pass --sources transcript.`);
    }
  }
  if (consent.affirmative && consent.window !== "recent") allHistory = true;
  if (dryRun && mode !== "reconcile") {
    console.error("--dry-run applies to --reconcile; use --no-write for an ingest dry run");
    process.exit(1);
  }

  return { mode, quiet, benchmark, includeUnattributed, allHistory, sources, limit, noWrite, dryRun, requestReconcile, scanSecrets };
}

// ── State file ─────────────────────────────────────────────────────────────
// Schema, transitions, migration and the lock live in lib/memory-ingest-landing.ts.

function loadState(): IngestState {
  const loaded = loadStateFile(STATE_PATH);
  if (loaded.kind === "unreadable") {
    console.error(
      `State file at ${STATE_PATH} is unreadable (${loaded.reason}); ` +
        (loaded.backup ? `backed up to ${loaded.backup} and ` : "") + "starting fresh.",
    );
  }
  return loaded.state;
}

/** Throws when the state file cannot be written: the run then fails (A1). */
function saveState(state: IngestState): void {
  saveStateFile(STATE_PATH, state);
}

// ── File hash + change detection ───────────────────────────────────────────

function fileSha256(path: string): string {
  // F9 (Codex finding 9): full-file hash. The prior 1MB cap silently
  // missed tail edits to long partial transcripts — exactly the
  // recovery case this pipeline needs to handle correctly. Realistic
  // max for an ingest source is ~50MB (long JSONL); fine to load in
  // memory for hashing.
  try {
    const buf = readFileSync(path);
    return createHash("sha256").update(buf).digest("hex");
  } catch {
    return "";
  }
}

function fileChangedSinceState(path: string, state: IngestState, verifyHash = false): boolean {
  const entry = state.sessions[path];
  if (isRetryable(entry)) return true;
  try {
    const st = statSync(path);
    const mtimeNs = Math.floor(st.mtimeMs * 1e6);
    if (!verifyHash && mtimeNs === entry.mtime_ns) return false;
    const sha = fileSha256(path);
    if (sha === entry.sha256) {
      // mtime changed but content didn't; just refresh mtime to skip future hashing
      entry.mtime_ns = mtimeNs;
      return false;
    }
    return true;
  } catch {
    return true;
  }
}

// ── Walkers ────────────────────────────────────────────────────────────────

interface WalkContext {
  args: CliArgs;
  state: IngestState;
  windowStartMs: number; // ignore files older than this unless --all-history
  consent: TranscriptConsent;
  scope: TranscriptScopeCounts;
}

export function emptyScopeCounts(): TranscriptScopeCounts {
  return { pre_cutoff: 0, missing_start: 0, not_allowlisted: 0, sessions_selected: 0 };
}

function makeWalkContext(args: CliArgs, state: IngestState, scope: TranscriptScopeCounts = emptyScopeCounts()): WalkContext {
  const ninetyDaysAgoMs = Date.now() - 90 * 24 * 60 * 60 * 1000;
  return {
    args,
    state,
    windowStartMs: args.allHistory ? 0 : ninetyDaysAgoMs,
    consent: readIngestConsent(),
    scope,
  };
}

/**
 * The `new@` cutoff, applied in both parsers' walks on each session's first
 * record timestamp (read from the file prefix, never mtime): a session that
 * started before the cutoff and was appended later stays out, and a session
 * with no start timestamp is excluded (fail-closed).
 */
function sessionPassesCutoff(ctx: WalkContext, path: string): boolean {
  const why = cutoffExclusion(ctx.consent, ctx.consent.cutoff === undefined ? null : transcriptPrefix(path).startedAt);
  if (why === "pre-cutoff") ctx.scope.pre_cutoff++;
  else if (why === "missing-start") ctx.scope.missing_start++;
  return why === null;
}

/** The transcript_repos allowlist, applied after the attribution gate. */
function sessionRepoAllowed(ctx: WalkContext, remote: string | undefined): boolean {
  if (repoExclusion(ctx.consent, remote) === null) return true;
  ctx.scope.not_allowlisted++;
  return false;
}

function* walkClaudeCodeProjects(ctx: WalkContext): Generator<{ path: string; type: MemoryType }> {
  const root = join(HOME, ".claude", "projects");
  if (!existsSync(root)) return;
  let projectDirs: string[];
  try {
    projectDirs = readdirSync(root);
  } catch {
    return;
  }
  for (const dir of projectDirs) {
    const fullDir = join(root, dir);
    let entries: string[];
    try {
      entries = readdirSync(fullDir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.endsWith(".jsonl")) continue;
      const fullPath = join(fullDir, entry);
      try {
        const st = statSync(fullPath);
        if (st.mtimeMs < ctx.windowStartMs) continue;
      } catch {
        continue;
      }
      if (!sessionPassesCutoff(ctx, fullPath)) continue;
      yield { path: fullPath, type: "transcript" };
    }
  }
}

function* walkCodexSessions(ctx: WalkContext): Generator<{ path: string; type: MemoryType }> {
  const root = join(HOME, ".codex", "sessions");
  if (!existsSync(root)) return;
  // Date-bucketed: YYYY/MM/DD/rollout-*.jsonl. Walk up to 4 levels deep.
  function* recurse(dir: string, depth: number): Generator<string> {
    if (depth > 4) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        yield* recurse(full, depth + 1);
      } else if (entry.endsWith(".jsonl")) {
        if (st.mtimeMs >= ctx.windowStartMs) yield full;
      }
    }
  }
  for (const path of recurse(root, 0)) {
    if (!sessionPassesCutoff(ctx, path)) continue;
    yield { path, type: "transcript" };
  }
}

function* walkGstackArtifacts(ctx: WalkContext): Generator<{ path: string; type: MemoryType }> {
  const projectsRoot = join(GSTACK_HOME, "projects");

  // Eureka log: ~/.gstack/analytics/eureka.jsonl
  const eurekaLog = join(GSTACK_HOME, "analytics", "eureka.jsonl");
  if (existsSync(eurekaLog) && ctx.args.sources.has("eureka")) {
    yield { path: eurekaLog, type: "eureka" };
  }

  // Builder profile: ~/.gstack/builder-profile.jsonl
  const builderProfile = join(GSTACK_HOME, "builder-profile.jsonl");
  if (existsSync(builderProfile) && ctx.args.sources.has("builder-profile-entry")) {
    yield { path: builderProfile, type: "builder-profile-entry" };
  }

  if (!existsSync(projectsRoot)) return;
  let slugs: string[];
  try {
    slugs = readdirSync(projectsRoot);
  } catch {
    return;
  }
  for (const slug of slugs) {
    const projDir = join(projectsRoot, slug);
    let st;
    try {
      st = statSync(projDir);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;

    // learnings.jsonl
    const learnings = join(projDir, "learnings.jsonl");
    if (existsSync(learnings) && ctx.args.sources.has("learning")) {
      yield { path: learnings, type: "learning" };
    }

    // timeline.jsonl
    const timeline = join(projDir, "timeline.jsonl");
    if (existsSync(timeline) && ctx.args.sources.has("timeline")) {
      yield { path: timeline, type: "timeline" };
    }

    // ceo-plans/*.md
    if (ctx.args.sources.has("ceo-plan")) {
      const ceoPlans = join(projDir, "ceo-plans");
      if (existsSync(ceoPlans)) {
        let pe: string[];
        try {
          pe = readdirSync(ceoPlans);
        } catch {
          pe = [];
        }
        for (const e of pe) {
          if (e.endsWith(".md")) {
            yield { path: join(ceoPlans, e), type: "ceo-plan" };
          }
        }
      }
    }

    // *-design-*.md (top-level in proj dir)
    if (ctx.args.sources.has("design-doc")) {
      let pe: string[];
      try {
        pe = readdirSync(projDir);
      } catch {
        pe = [];
      }
      for (const e of pe) {
        if (e.endsWith(".md") && e.includes("design-")) {
          yield { path: join(projDir, e), type: "design-doc" };
        }
      }
    }

    // retros — *.md under projDir/retros/ if exists, or retro-*.md at projDir
    if (ctx.args.sources.has("retro")) {
      const retroDir = join(projDir, "retros");
      if (existsSync(retroDir)) {
        let pe: string[];
        try {
          pe = readdirSync(retroDir);
        } catch {
          pe = [];
        }
        for (const e of pe) {
          if (e.endsWith(".md")) {
            yield { path: join(retroDir, e), type: "retro" };
          }
        }
      }
    }
  }
}

function* walkAllSources(ctx: WalkContext): Generator<{ path: string; type: MemoryType }> {
  if (ctx.args.sources.has("transcript")) {
    yield* walkClaudeCodeProjects(ctx);
    yield* walkCodexSessions(ctx);
  }
  yield* walkGstackArtifacts(ctx);
}

// ── Renderers ──────────────────────────────────────────────────────────────

interface ParsedSession {
  agent: "claude-code" | "codex";
  session_id: string;
  cwd: string;
  start_time?: string;
  end_time?: string;
  message_count: number;
  tool_calls: number;
  body: string;
  partial: boolean;
}

export function parseTranscriptJsonl(path: string, raw?: string): ParsedSession | null {
  // Best-effort tolerant parser. Handles truncated last lines (D10 partial-flag).
  try {
    raw ??= readFileSync(path, "utf-8");
  } catch {
    return null;
  }
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length === 0) return null;

  // Detect partial: if the last line doesn't end with `}` or doesn't parse, mark partial.
  let partial = false;
  let parsedLines: any[] = [];
  for (let i = 0; i < lines.length; i++) {
    try {
      parsedLines.push(JSON.parse(lines[i]));
    } catch {
      // Last-line truncation is the common case (D10).
      if (i === lines.length - 1) partial = true;
      else continue;
    }
  }
  if (parsedLines.length === 0) return null;

  // Detect format: Codex `session_meta` or Claude Code `type: user|assistant|tool`
  const first = parsedLines[0];
  const isCodex = first?.type === "session_meta" || first?.payload?.id != null;
  const agent: "claude-code" | "codex" = isCodex ? "codex" : "claude-code";

  let session_id = "";
  let cwd = "";
  let start_time: string | undefined;
  let end_time: string | undefined;

  if (isCodex) {
    session_id = first.payload?.id || first.id || basename(path, ".jsonl");
    cwd = first.payload?.cwd || first.cwd || "";
    start_time = first.timestamp || first.payload?.timestamp;
  } else {
    // Claude Code: look for cwd in first non-queue record
    for (const r of parsedLines) {
      if (r?.cwd) {
        cwd = r.cwd;
        break;
      }
    }
    session_id = basename(path, ".jsonl");
    start_time = parsedLines.find((r) => r?.timestamp)?.timestamp;
    const last = parsedLines[parsedLines.length - 1];
    end_time = last?.timestamp;
  }

  // Render body — collapsed conversation
  let messageCount = 0;
  let toolCalls = 0;
  const bodyParts: string[] = [];
  for (const rec of parsedLines) {
    if (rec?.type === "user" || rec?.message?.role === "user") {
      const content = extractContentText(rec);
      if (content) {
        bodyParts.push(`## User\n\n${content}`);
        messageCount++;
      }
    } else if (rec?.type === "assistant" || rec?.message?.role === "assistant") {
      const content = extractContentText(rec);
      if (content) {
        bodyParts.push(`## Assistant\n\n${content}`);
        messageCount++;
      }
    } else if (rec?.type === "tool" || rec?.tool_use_id || rec?.tool_call) {
      toolCalls++;
      // Collapse to one-line summary
      const tool = rec?.name || rec?.tool || rec?.tool_call?.name || "tool";
      bodyParts.push(`### Tool call: ${tool}`);
    } else if (isCodex && rec?.payload?.message) {
      // Legacy Codex shape: each record has payload.message
      const msg = rec.payload.message;
      const role = msg.role || "user";
      const content = extractContentText(msg);
      if (content) {
        bodyParts.push(`## ${role.charAt(0).toUpperCase() + role.slice(1)}\n\n${content}`);
        messageCount++;
      }
    } else if (isCodex && rec?.type === "response_item" && rec?.payload?.type === "message") {
      // Current Codex rollout shape (#2105): records are
      // { type: 'response_item', payload: { type: 'message', role, content: [...] } }.
      // The legacy payload.message branch never fires on these, which rendered
      // every Codex session as an empty shell (message_count: 0, 243/243 on
      // the reporting machine). Flatten payload.content like the Claude branch.
      const role = rec.payload.role || "user";
      const content = extractContentText(rec.payload);
      if (content) {
        bodyParts.push(`## ${role.charAt(0).toUpperCase() + role.slice(1)}\n\n${content}`);
        messageCount++;
      }
    }
  }

  const body = bodyParts.join("\n\n").slice(0, 200000); // hard cap 200KB

  return {
    agent,
    session_id,
    cwd,
    start_time,
    end_time,
    message_count: messageCount,
    tool_calls: toolCalls,
    body,
    partial,
  };
}

function extractContentText(rec: any): string {
  if (!rec) return "";
  if (typeof rec.content === "string") return rec.content;
  if (typeof rec.text === "string") return rec.text;
  if (typeof rec.message?.content === "string") return rec.message.content;
  if (Array.isArray(rec.message?.content)) {
    return rec.message.content
      .map((c: any) => (typeof c === "string" ? c : c?.text || ""))
      .filter(Boolean)
      .join("\n");
  }
  if (Array.isArray(rec.content)) {
    return rec.content
      .map((c: any) => (typeof c === "string" ? c : c?.text || ""))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

// Memo: probe and prepare both resolve remotes per-transcript, and transcripts
// share a small set of cwds — without this an 11.7K-file probe would spawn git
// 11.7K times instead of once per distinct cwd.
const REMOTE_MEMO = new Map<string, string>();

function resolveGitRemote(cwd: string): string {
  if (!cwd) return "";
  const memo = REMOTE_MEMO.get(cwd);
  if (memo !== undefined) return memo;
  const resolved = resolveGitRemoteUncached(cwd);
  REMOTE_MEMO.set(cwd, resolved);
  return resolved;
}

function resolveGitRemoteUncached(cwd: string): string {
  try {
    // execFileSync (no shell) so `cwd` cannot trigger command substitution.
    // Transcript JSONL records are an untrusted surface (a poisoned `.cwd`
    // value containing `"$(...)"` survived `JSON.stringify` interpolation
    // into a `/bin/sh -c` context, since JSON quoting does not escape `$`
    // or backticks). Mirrors the execFileSync pattern this module already
    // uses for `gbrainAvailable()` (line 762) and `gbrainPutPage()` (line 816).
    const out = execFileSync("git", ["-C", cwd, "remote", "get-url", "origin"], {
      encoding: "utf-8",
      timeout: 2000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return canonicalizeRemote(out.trim());
  } catch {
    return "";
  }
}

function repoSlug(remote: string): string {
  if (!remote) return "_unattributed";
  // github.com/foo/bar → foo-bar
  const parts = remote.split("/");
  if (parts.length >= 3) return `${parts[parts.length - 2]}-${parts[parts.length - 1]}`;
  return remote.replace(/\//g, "-");
}

/**
 * gbrain's import walker prunes every path segment that starts with a dot
 * (isPathPruned in gbrain's core/sync.ts), and a page slug maps 1:1 onto its
 * staged path. A `.claude` project slug therefore staged a file gbrain never
 * collected, the batch was refused, and ingest wedged on it forever (#2884).
 * Leading dots become "dot-" in every segment; state recorded under the old
 * slug maps through the same function (disambiguateSlugs), so a source keeps
 * one page instead of gaining a second.
 */
export function safeSlug(slug: string): string {
  return slug.split("/").map((seg) => seg.replace(/^\.+/, "dot-")).join("/");
}

function dateOnly(ts: string | undefined): string {
  if (!ts) return new Date().toISOString().slice(0, 10);
  try {
    return new Date(ts).toISOString().slice(0, 10);
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

/** A timestamp as ISO-8601 UTC, or "" when absent or unparseable. */
function isoOrEmpty(ts: string | undefined): string {
  const ms = ts ? Date.parse(ts) : NaN;
  return Number.isFinite(ms) ? new Date(ms).toISOString() : "";
}

export function buildTranscriptPage(path: string, session: ParsedSession): PageRecord {
  const remote = resolveGitRemote(session.cwd);
  const slug_repo = repoSlug(remote);
  const date = dateOnly(session.start_time);
  const sessionPrefix = session.session_id.slice(0, 12);
  const slug = safeSlug(`transcripts/${session.agent}/${slug_repo}/${date}-${sessionPrefix}`);
  const title = `${session.agent} session — ${slug_repo} — ${date}`;
  const tags = [
    "transcript",
    `agent:${session.agent}`,
    `repo:${slug_repo}`,
    `date:${date}`,
  ];
  if (session.partial) tags.push("partial:true");

  const stats = statSync(path);
  const sha = fileSha256(path);

  const fmLines = [
    "---",
    `agent: ${session.agent}`,
    `session_id: ${session.session_id}`,
    `cwd: ${session.cwd || ""}`,
    `git_remote: ${remote || "_unattributed"}`,
    `start_time: ${session.start_time || ""}`,
    `session_started_at: ${isoOrEmpty(session.start_time)}`,
    `end_time: ${session.end_time || ""}`,
    `message_count: ${session.message_count}`,
    `tool_calls: ${session.tool_calls}`,
    `source_path: ${path}`,
  ];
  if (session.partial) fmLines.push("partial: true");
  fmLines.push("---");
  // The closing `---` fence MUST terminate its own line. session.body always
  // starts with "## " (never a newline), so without the trailing "\n" the fence
  // renders as `---## User`, which gray-matter/gbrain reject as a closer (the
  // fence regex in gbrain markdown.ts requires `\n---(\r?\n|$)`). gbrain then
  // scans to the next standalone `---` in the transcript, parses the prose
  // between as YAML, and drops the whole page with "Invalid YAML frontmatter".
  // A prior `.filter((l) => l !== "")` — added to drop the empty non-partial
  // line — also stripped the blank that used to terminate the fence line, so
  // every transcript whose body carries a later `---` horizontal rule silently
  // failed to ingest. The explicit `+ "\n\n"` restores the fence newline plus a
  // blank separator, matching the artifact-page branch in renderPageBody().
  const frontmatter = fmLines.join("\n") + "\n\n";

  return {
    slug,
    title,
    type: "transcript",
    agent: session.agent,
    body: frontmatter + session.body,
    tags,
    source_path: path,
    session_id: session.session_id,
    cwd: session.cwd,
    // Store the normalized sentinel, matching the frontmatter above: a raw ""
    // is falsy and slid through the policy filter's !p.git_remote fast-path,
    // so under --include-unattributed a `_unattributed → deny` policy never
    // applied to exactly the pages it names (#2353).
    git_remote: remote || "_unattributed",
    start_time: session.start_time,
    end_time: session.end_time,
    partial: session.partial,
    size_bytes: stats.size,
    content_sha256: sha,
  };
}

function buildArtifactPage(path: string, type: MemoryType, raw?: string): PageRecord {
  const stats = statSync(path);
  const sha = fileSha256(path);
  raw ??= readFileSync(path, "utf-8");

  // Extract repo slug from path: ~/.gstack/projects/<slug>/...
  let slug_repo = "_unattributed";
  const m = path.match(/\/\.gstack\/projects\/([^/]+)\//);
  if (m) slug_repo = m[1];

  const date = new Date(stats.mtimeMs).toISOString().slice(0, 10);
  const baseName = basename(path, path.endsWith(".jsonl") ? ".jsonl" : ".md");

  const slug = safeSlug(`${type}s/${slug_repo}/${date}-${baseName}`);
  const title = `${type} — ${slug_repo} — ${date} — ${baseName}`;

  const tags = [type, `repo:${slug_repo}`, `date:${date}`];

  // Truncate body to 200KB
  const body = raw.slice(0, 200000);

  return {
    slug,
    title,
    type,
    body,
    tags,
    source_path: path,
    git_remote: slug_repo,
    size_bytes: stats.size,
    content_sha256: sha,
  };
}

// ── Writer (batch via `gbrain import <dir>`) ───────────────────────────────
//
// Architecture (write, verify, then stamp — A1):
//
//   walkAllSources(ctx)
//     → for each path: mtime-skip / read bytes once (fingerprint) / parse / buildPage
//     → renderPageBody injects title/type/tags + gstack_content_sha256
//     → writeStaged: mkdir -p slug subdirs (D1), write ${slug}.md
//   → one staging dir + `gbrain import --json [--source-id]` per source (D6)
//   → classifyImport: named failures from --json `failures`, stderr
//     "Skipped <rel>:" lines and the sync-failures ledger (written only for
//     git import dirs, so usually empty here); an unnamed failure refuses
//     the whole batch, and a batch refused 3 times is bisected
//   → pages not named: imported_unverified, then the landing check
//     (gbrain list per source, bounded gbrain get --json) stamps ingested
//   → state saved atomically by main(); a save failure fails the run
//
// gbrain's content_hash makes re-importing identical content cheap, so a
// page that did not land is simply retried on the next run.

let _gbrainAvailability: boolean | null = null;
function gbrainAvailable(): boolean {
  if (_gbrainAvailability !== null) return _gbrainAvailability;
  try {
    // Probe `--help` for the `import` subcommand. gbrain v0.20.0+ ships
    // `import <dir>` (batch markdown import via path-authoritative slugs).
    // If absent, we surface a single clean error here rather than failing
    // the whole stage with a confusing usage message from gbrain itself.
    // `gbrain --help` probes only CLI availability, not DB connectivity, so
    // it doesn't strictly need DATABASE_URL. But routing through the helper
    // keeps the invariant test from chasing exceptions per call site.
    const help = execGbrainText(["--help"], { timeout: 5000 });
    _gbrainAvailability = /^\s+import\s/m.test(help);
  } catch {
    _gbrainAvailability = false;
  }
  return _gbrainAvailability;
}

/**
 * Build the markdown body with YAML frontmatter (title/type/tags) injected.
 *
 * Two cases:
 *  - Page body already starts with `---\n` (transcripts) — inject into the
 *    existing frontmatter block before its close fence so gbrain's frontmatter
 *    parser picks up the fields alongside any session-level metadata the
 *    transcript builder already wrote (session_id, cwd, git_remote, etc.).
 *  - No leading frontmatter (raw artifacts: design-docs, learnings, etc.) —
 *    wrap with a fresh frontmatter block carrying title/type/tags. Without
 *    this branch, artifact pages would land in gbrain with empty metadata.
 *
 * gbrain enforces slug = path-derived (slugifyPath in gbrain's sync.ts).
 * We do NOT set `slug:` in frontmatter — the staging-dir filename is the
 * source of truth and gbrain rejects mismatches.
 */
export function renderPageBody(page: PageRecord): string {
  let body = page.body;
  if (body.startsWith("---\n")) {
    const end = body.indexOf("\n---", 4);
    if (end > 0) {
      const inject = [
        `title: ${JSON.stringify(page.title)}`,
        `type: ${page.type}`,
        `tags:`,
        ...page.tags.map((t) => `  - ${t}`),
      ].join("\n");
      body = body.slice(0, end) + "\n" + inject + body.slice(end);
    }
  } else {
    body = [
      "---",
      `title: ${JSON.stringify(page.title)}`,
      `type: ${page.type}`,
      `tags: [${page.tags.map((t) => JSON.stringify(t)).join(", ")}]`,
      "---",
      "",
      body,
    ].join("\n");
  }
  // Strip NUL bytes — Postgres rejects 0x00 in UTF-8 text columns. Some Claude
  // Code transcripts contain NUL inside user-pasted content or tool output, and
  // surfacing those as `internal_error: invalid byte sequence` from the brain
  // is unhelpful when we can sanitize at write time. Originally landed in v1.32.0.0
  // (PR #1411) on the per-file `gbrain put` path; moved here so all staged
  // pages still get the same sanitization.
  body = body.replace(/\x00/g, "");
  return body;
}

type SourceFingerprint = Pick<IngestState["sessions"][string], "mtime_ns" | "sha256">;

interface PreparedPage {
  /** Page slug (path-shaped, e.g. "transcripts/claude-code/foo"). */
  slug: string;
  /** Original source file on disk (e.g. ~/.claude/projects/.../foo.jsonl). */
  source_path: string;
  /** Full markdown including frontmatter — ready to write. */
  rendered_body: string;
  /** mtime + sha256 of the exact bytes parsed (A1): the stamp never describes a newer file. */
  source_fingerprint: SourceFingerprint;
  /** gstack_content_sha256 written into the page's frontmatter; the landing check compares it. */
  content_sha256: string;
  /** Carry-through fields for state recording on success. */
  page_slug: string;
  partial: boolean;
  /** Memory type — the per-remote policy filter (#2392) applies to transcripts only. */
  type: MemoryType;
  /**
   * Canonical git remote ("host/org/repo") for transcript pages; undefined
   * for artifacts (whose PageRecord.git_remote is a project slug, not a
   * remote — artifacts are never policy-filtered).
   */
  git_remote?: string;
}

function sourceFingerprintForStamp(page: PreparedPage): SourceFingerprint | null {
  const current = {
    mtime_ns: Math.floor(statSync(page.source_path).mtimeMs * 1e6),
    sha256: fileSha256(page.source_path),
  };
  const prepared = page.source_fingerprint;
  if (current.mtime_ns !== prepared.mtime_ns || current.sha256 !== prepared.sha256) return null;
  return prepared;
}

/**
 * Add the gstack_content_sha256 frontmatter field (a hash of the rendered
 * page without it). gbrain stores its own content hash over the parsed page,
 * which gstack cannot recompute, so the landing check compares this field.
 */
export function withContentHash(rendered: string): { body: string; sha: string } {
  const sha = createHash("sha256").update(rendered).digest("hex");
  return { body: `---\ngstack_content_sha256: ${sha}\n${rendered.slice(4)}`, sha };
}

interface StagingResult {
  staging_dir: string;
  written: number;
  errors: Array<{ slug: string; error: string }>;
  /** Map from staging-dir-relative path (e.g. "transcripts/foo.md") → source path. */
  stagedPathToSource: Map<string, string>;
}

/**
 * Write prepared pages to a staging dir, mirroring slug hierarchy.
 *
 * D1: gbrain's `slugifyPath` (sync.ts:260) derives the slug from the
 * directory-aware relative path inside the import dir, so slugs containing
 * slashes (e.g. "transcripts/claude-code/foo") must live in matching
 * subdirectories of the staging dir. Otherwise the slug becomes flattened
 * or rejected by gbrain's path-vs-frontmatter slug check (import-file.ts:429).
 *
 * Filename = `${slug}.md`. mkdir is recursive. Existing files overwrite.
 * Errors per-file are collected; the whole batch is best-effort.
 */
/**
 * Staging-relative path for a prepared page's slug. Single source of truth so
 * writeStaged() (which mints the map) and the resume-path reconstruction (#1802
 * C4) compute identical keys — if they diverge, readNewFailures() silently stops
 * mapping gbrain's failures back to sources and failed files get marked ingested.
 */
export function stagedRelPath(slug: string): string {
  return `${slug}.md`;
}

function writeStaged(prepared: PreparedPage[], stagingDir: string, scanned = false): StagingResult {
  mkdirSync(stagingDir, { recursive: true });
  const stagedPathToSource = new Map<string, string>();
  const errors: Array<{ slug: string; error: string }> = [];
  let written = 0;
  for (const p of prepared) {
    const relPath = stagedRelPath(p.slug);
    const absPath = join(stagingDir, relPath);
    let pendingDir: string | undefined;
    try {
      mkdirSync(dirname(absPath), { recursive: true });
      if (scanned) {
        pendingDir = mkdtempSync(join(GSTACK_HOME, ".brain-ingest-write-"));
        const pendingPath = join(pendingDir, "page.md");
        writeFileSync(pendingPath, p.rendered_body, { encoding: "utf-8", mode: 0o600 });
        renameSync(pendingPath, absPath);
      } else {
        writeFileSync(absPath, p.rendered_body, "utf-8");
      }
      stagedPathToSource.set(relPath, p.source_path);
      written++;
    } catch (err) {
      errors.push({ slug: p.slug, error: (err as Error).message });
    } finally {
      if (pendingDir) rmSync(pendingDir, { recursive: true, force: true });
    }
  }
  return { staging_dir: stagingDir, written, errors, stagedPathToSource };
}

/**
 * Read failures appended to ~/.gbrain/sync-failures.jsonl since the
 * snapshotted byte offset, and map them back to source paths.
 *
 * D7: gbrain import writes per-file failures to sync-failures.jsonl so
 * "callers can gate state advances", but ONLY when the import dir is a git
 * repo, and the staging dir never is. So for staged imports this is usually
 * empty; classifyImport() also reads the --json `failures` list and stderr.
 * We snapshot the file size before import and read only the appended bytes
 * after, so we never confuse new entries with prior-run leftovers.
 *
 * Each line is `{ path, error, code, commit, ts }`. The `path` is the
 * staging-dir-relative filename gbrain saw (e.g. "transcripts/foo.md").
 * stagedPathToSource maps that back to the original source file.
 */
export function readNewFailures(
  syncFailuresPath: string,
  preImportOffset: number,
  stagedPathToSource: Map<string, string>,
): Set<string> {
  const failed = new Set<string>();
  try {
    if (!existsSync(syncFailuresPath)) return failed;
    const stat = statSync(syncFailuresPath);
    if (stat.size <= preImportOffset) return failed;
    // Read appended bytes only. readSync with a positional offset works
    // synchronously without slurping the whole file.
    const fd = openSync(syncFailuresPath, "r");
    try {
      const buf = Buffer.alloc(stat.size - preImportOffset);
      readSync(fd, buf, 0, buf.length, preImportOffset);
      const text = buf.toString("utf-8");
      for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const entry = JSON.parse(trimmed) as { path?: string };
          if (entry.path) {
            const source = stagedPathToSource.get(entry.path);
            if (source) failed.add(source);
          }
        } catch {
          // ignore malformed line
        }
      }
    } finally {
      closeSync(fd);
    }
  } catch {
    // Best-effort: the landing check still refuses pages that did not land.
  }
  return failed;
}

// ── Main ingest passes ─────────────────────────────────────────────────────

/**
 * The ONE attribution gate (#2394): a transcript is attributable iff its cwd
 * resolves to a git remote. Both probeMode (via transcriptPrefix +
 * resolveGitRemote — the same memoized resolver) and preparePages route
 * through THIS logic, so the two stages' post-attribution counts are
 * structurally identical — the parity the probe report promises.
 */
function sessionIsAttributable(cwd: string | undefined | null): boolean {
  if (!cwd) return false;
  return resolveGitRemote(cwd) !== "";
}

/**
 * Bounded prefix for the probe's cheap-parse (plan C7): transcripts run to
 * tens of MB, and the probe only needs the cwd, which both agent formats put
 * on the FIRST records. 256KB is orders of magnitude past any real header.
 */
const TRANSCRIPT_PROBE_MAX_BYTES = 256 * 1024;

/**
 * Lightweight cwd extraction for the probe: reads a BOUNDED prefix (first
 * 256KB, never the whole file — plan C7: the probe must stay a cheap parse on
 * multi-MB transcripts) and extracts the cwd with EXACTLY
 * parseTranscriptJsonl's rules. The caller resolves attribution/policy via
 * resolveGitRemote (memoized). Avoids the full parse (body rendering, message
 * counting) because probe only needs the cwd.
 *
 * Extraction MIRRORS parseTranscriptJsonl (the single source of truth for
 * cwd semantics — keep the two in lockstep):
 *   - the first PARSEABLE line decides the format (Codex: type=session_meta
 *     or payload.id; else Claude Code);
 *   - Codex cwd comes from that FIRST record ONLY (payload.cwd || cwd) —
 *     a cwd appearing only on a later record is NOT used, exactly as
 *     parseTranscriptJsonl ignores it, so probe and prepare can never
 *     diverge on the same file;
 *   - Claude Code cwd comes from the first record that carries one;
 *   - unparseable lines are skipped (the truncated-tail case included).
 *
 * The session start (the `new@` cutoff input) follows the same rules: Codex
 * takes the first record's timestamp (or payload.timestamp), Claude Code the
 * first record that carries a timestamp. A start beyond the prefix reads as
 * missing, which a cutoff treats as excluded.
 *
 * Non-transcript types (artifacts) always pass — the attribution filter in
 * preparePages only applies to transcripts (#2394).
 */
export function transcriptPrefix(path: string): { cwd: string; startedAt: string } {
  // Chunked read until the prefix contains at least one COMPLETE record
  // (newline), up to the hard cap — a first record larger than one chunk
  // (giant pasted prompt) must not truncate mid-JSON and mis-classify a
  // session --bulk would accept (probe/bulk parity).
  let raw: string;
  try {
    const fd = openSync(path, "r");
    try {
      const chunk = Buffer.alloc(TRANSCRIPT_PROBE_MAX_BYTES);
      let acc = "";
      let offset = 0;
      const HARD_CAP = TRANSCRIPT_PROBE_MAX_BYTES * 16; // 4MB ceiling
      while (offset < HARD_CAP) {
        const n = readSync(fd, chunk, 0, chunk.length, offset);
        if (n <= 0) break;
        acc += chunk.toString("utf-8", 0, n);
        offset += n;
        if (acc.includes("\n")) break; // at least one complete record
      }
      raw = acc;
    } finally {
      closeSync(fd);
    }
  } catch {
    return { cwd: "", startedAt: "" };
  }
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);

  let cwd = "";
  let startedAt = "";
  let sawFirstParseable = false;
  for (const line of lines) {
    let rec: any;
    try {
      rec = JSON.parse(line);
    } catch {
      continue; // mirrors parseTranscriptJsonl: unparseable lines are skipped
    }
    if (!sawFirstParseable) {
      sawFirstParseable = true;
      // Format detection mirrors parseTranscriptJsonl's `first` record check.
      const isCodex = rec?.type === "session_meta" || rec?.payload?.id != null;
      if (isCodex) {
        // Codex: cwd and start come from the session_meta FIRST record only.
        cwd = rec.payload?.cwd || rec.cwd || "";
        startedAt = rec.timestamp || rec.payload?.timestamp || "";
        break;
      }
    }
    // Claude Code: the first record with a cwd and the first with a timestamp.
    if (!cwd && rec?.cwd) cwd = rec.cwd;
    if (!startedAt && rec?.timestamp) startedAt = rec.timestamp;
    if (cwd && startedAt) break;
  }
  return { cwd, startedAt: typeof startedAt === "string" ? startedAt : "" };
}

async function probeMode(args: CliArgs): Promise<ProbeReport> {
  const state = loadState();
  const ctx = makeWalkContext(args, state);

  const byType: Record<MemoryType, { count: number; bytes: number }> = {
    transcript: { count: 0, bytes: 0 },
    eureka: { count: 0, bytes: 0 },
    learning: { count: 0, bytes: 0 },
    timeline: { count: 0, bytes: 0 },
    "ceo-plan": { count: 0, bytes: 0 },
    "design-doc": { count: 0, bytes: 0 },
    retro: { count: 0, bytes: 0 },
    "builder-profile-entry": { count: 0, bytes: 0 },
  };

  let totalFiles = 0;
  let totalBytes = 0;
  let newCount = 0;
  let updatedCount = 0;
  let unchangedCount = 0;
  let skippedUnattributed = 0;
  let skippedPolicyDeny = 0;
  let skippedPolicyReadonly = 0;

  // Two-phase walk (#2392 parity): collect candidates first (remembering each
  // transcript's resolved remote), THEN apply the same per-remote policy
  // filter --bulk applies via one repoPolicyTierBatch spawn. Counting during
  // the walk would report policy-denied transcripts as ingestible — probe's
  // numbers must match what --bulk would actually write.
  const candidates: Array<{ path: string; type: MemoryType; remote: string }> = [];
  for (const { path, type } of walkAllSources(ctx)) {
    // Apply the same attribution filter preparePages uses (#2394):
    // skip transcripts with no resolvable git remote unless --include-unattributed.
    let remote = "";
    if (type === "transcript") {
      const { cwd } = transcriptPrefix(path);
      remote = cwd ? resolveGitRemote(cwd) : "";
      if (!args.includeUnattributed && remote === "") {
        skippedUnattributed++;
        continue;
      }
      if (!sessionRepoAllowed(ctx, remote || "_unattributed")) continue;
    }
    candidates.push({ path, type, remote });
  }

  // Batch policy check — same hasRepoPolicyStore fast path as preparePages:
  // no store on disk → zero policy work. Only transcripts with a resolved
  // remote are policy-filtered; artifacts never are (#2392). A missing or
  // errored verdict counts as "none" here — probe is read-only and must not
  // hard-fail the way the write path does.
  if (hasRepoPolicyStore()) {
    const remotes = [...new Set(candidates.filter((c) => c.type === "transcript" && c.remote).map((c) => c.remote))];
    if (remotes.length > 0) {
      const verdicts = repoPolicyTierBatch(remotes);
      for (let i = candidates.length - 1; i >= 0; i--) {
        const c = candidates[i];
        if (c.type !== "transcript" || !c.remote) continue;
        const tier = verdicts.get(c.remote)?.tier ?? "none";
        if (tier === "deny") {
          skippedPolicyDeny++;
          candidates.splice(i, 1);
        } else if (tier === "read-only") {
          skippedPolicyReadonly++;
          candidates.splice(i, 1);
        }
      }
    }
  }

  for (const { path, type } of candidates) {
    totalFiles++;
    let size = 0;
    try {
      size = statSync(path).size;
    } catch {
      continue;
    }
    byType[type].count++;
    byType[type].bytes += size;
    totalBytes += size;

    const entry = state.sessions[path];
    if (!entry) newCount++;
    else if (fileChangedSinceState(path, state, args.scanSecrets)) updatedCount++;
    else unchangedCount++;
  }

  // Per ED2: ~25-35 min for ~11.7K transcripts = ~150ms/page synchronous
  // (gitleaks + render + put + embedding). Scale linearly.
  const estimateMinutes = Math.max(1, Math.round((newCount + updatedCount) * 0.15 / 60));

  return {
    total_files: totalFiles,
    total_bytes: totalBytes,
    by_type: byType,
    new_count: newCount,
    updated_count: updatedCount,
    unchanged_count: unchangedCount,
    skipped_unattributed: skippedUnattributed,
    skipped_policy_deny: skippedPolicyDeny,
    skipped_policy_readonly: skippedPolicyReadonly,
    scope: ctx.scope,
    estimate_minutes: estimateMinutes,
  };
}

/**
 * Disambiguate colliding page slugs before staging (#2724), consulting the
 * ingest state so an assignment is stable across RUNS, not just within one.
 *
 * Two distinct source files can map to one transcript slug
 * (transcripts/<agent>/<repo>/<date>-<session_id[:12]>): a session resumed
 * under the same session_id on one day, or two session_ids sharing a 12-char
 * prefix. writeStaged() names each file `${slug}.md`, so the second OVERWRITES
 * the first — `written` counts both but only one lands on disk, gbrain collects
 * N-1 of N, and the staged-vs-collected reconciliation guard (correctly) fails
 * the whole batch. It repeats every run until the inputs age out of the window.
 *
 * Within a run: keep the first occurrence's slug; give each later collider a
 * stable `-<sha8(source_path)>` suffix, mutating slug + page_slug together so
 * every downstream consumer (writeStaged, readNewFailures mapping, state
 * recording) computes the same key.
 *
 * Across runs (the state consult): "first occurrence" is walk-order-dependent,
 * so without memory a source that got the suffixed slug in one run could take
 * the bare slug in the next (its old collider aged out or was skipped as
 * unchanged) — gbrain then holds the SAME transcript under two slugs. Worse,
 * a NEW collider could claim a bare slug that state shows belongs to an
 * unchanged (not-restaged) source, silently overwriting that page in gbrain.
 * So: a slug recorded in state stays owned by its source_path — a re-ingested
 * source keeps its recorded slug verbatim, and a fresh assignment never takes
 * a slug owned by a DIFFERENT source. Legacy states that recorded the same
 * slug for two sources (pre-#2724 overwrites) resolve first-owner-wins and
 * self-heal on the next state write.
 */
export function disambiguateSlugs(
  pages: Array<Pick<PreparedPage, "slug" | "page_slug" | "source_path">>,
  state?: { sessions: Record<string, { page_slug: string }> },
): void {
  // slug → owning source_path, from prior runs. First writer wins on legacy
  // duplicate records; state key order is stable (re-read from the same file).
  const ownedBy = new Map<string, string>();
  for (const [src, rec] of Object.entries(state?.sessions ?? {})) {
    const owned = rec?.page_slug ? safeSlug(rec.page_slug) : "";
    if (owned && !ownedBy.has(owned)) ownedBy.set(owned, src);
  }
  const claimed = new Set<string>();
  const available = (slug: string, src: string) =>
    !claimed.has(slug) && (!ownedBy.has(slug) || ownedBy.get(slug) === src);

  for (const p of pages) {
    const recordedRaw = state?.sessions[p.source_path]?.page_slug;
    const recorded = recordedRaw ? safeSlug(recordedRaw) : undefined;
    if (recorded && !claimed.has(recorded) && ownedBy.get(recorded) === p.source_path) {
      claimed.add(recorded);
      p.slug = recorded;
      p.page_slug = recorded;
      continue;
    }
    let candidate = p.slug;
    if (!available(candidate, p.source_path)) {
      const suffix = createHash("sha256").update(p.source_path).digest("hex").slice(0, 8);
      candidate = `${p.slug}-${suffix}`;
      // Guarantee uniqueness even if a prior page already took the suffixed
      // slug (two colliders sharing a source_path-hash prefix is
      // astronomically unlikely, but a stuck source is not the place to
      // trust luck).
      let n = 1;
      while (!available(candidate, p.source_path)) candidate = `${p.slug}-${suffix}-${n++}`;
    }
    claimed.add(candidate);
    p.slug = candidate;
    p.page_slug = candidate;
  }
}

/**
 * Prepare phase: walk sources, apply incremental filters, parse into PageRecord,
 * render bodies with frontmatter, then apply the optional secret scan.
 * Returns the PreparedPage[] to stage + counts of files
 * filtered at each gate.
 *
 * Secret scanning policy (post 2026-05-10 perf review):
 *
 *   The actual cross-machine exfiltration boundary is `gstack-brain-sync`,
 *   which runs a regex-based secret scanner on the staged diff before
 *   `git commit` (see bin/gstack-brain-sync:78-110: AWS keys, GitHub
 *   tokens, OpenAI keys, PEM blocks, JWTs, bearer-token-in-JSON). That's
 *   the right place — it gates content leaving the machine.
 *
 *   memory-ingest, by contrast, moves data from one local file to a
 *   local PGLite database. Scanning every source file at ingest time
 *   doesn't change exposure (the secret already lives in plaintext
 *   where the user keeps their transcripts and artifacts) but costs
 *   ~470s on cold runs. We removed the per-file gitleaks gate as
 *   redundant defense-in-depth and made it opt-in via `--scan-secrets`
 *   for users who want belt-and-suspenders.
 */
function preparePages(
  args: CliArgs,
  ctx: WalkContext,
  state: IngestState,
  scanRenderedPages = args.scanSecrets,
): {
  prepared: PreparedPage[];
  skippedSecret: number;
  skippedDedup: number;
  skippedUnattributed: number;
  skippedPolicyReadonly: number;
  skippedPolicyDeny: number;
  parseFailed: number;
  partialPages: number;
  policyStoreExists: boolean;
  /**
   * #2392: set when the per-remote policy store EXISTS but could not be
   * read (corrupt file, spawn failure). The caller must abort before any
   * writes — proceeding would bypass a possibly-set deny policy.
   */
  policyError?: string;
} {
  const prepared: PreparedPage[] = [];
  let skippedSecret = 0;
  let skippedDedup = 0;
  let skippedUnattributed = 0;
  let parseFailed = 0;
  let partialPages = 0;

  // --limit semantics: "stop after N pages WRITTEN" = N policy-eligible pages.
  // When a per-remote policy store exists, eligibility is only known after the
  // batch policy check below, so the walk must not stop early — a denied-first
  // corpus would otherwise consume the limit and starve permitted pages. With
  // no store on disk, every prepared page is eligible and the in-loop break
  // keeps --limit cheap.
  const policyStoreExists = hasRepoPolicyStore();

  for (const { path, type } of walkAllSources(ctx)) {
    if (args.limit !== null && !policyStoreExists && prepared.length >= args.limit) break;

    // Incremental skips unchanged sources; a quarantined page is retried
    // only once its source changes, in every mode.
    const known = state.sessions[path];
    if ((args.mode === "incremental" || known?.status === "quarantined") && !fileChangedSinceState(path, state, args.scanSecrets)) {
      skippedDedup++;
      continue;
    }

    let page: PageRecord;
    let sourceFingerprint: SourceFingerprint;
    try {
      // A1: fingerprint the exact bytes that are parsed, so a transcript that
      // grows during the run is never stamped as its newer self.
      const mtime_ns = Math.floor(statSync(path).mtimeMs * 1e6);
      const bytes = readFileSync(path);
      sourceFingerprint = { mtime_ns, sha256: createHash("sha256").update(bytes).digest("hex") };
      const raw = bytes.toString("utf-8");
      if (type === "transcript") {
        const session = parseTranscriptJsonl(path, raw);
        if (!session) {
          parseFailed++;
          continue;
        }
        // The SAME gate probeMode uses (#2394) — routing both through
        // sessionIsAttributable is what makes probe counts trustworthy.
        // (Semantically identical to the old two-step check: no cwd, or a cwd
        // whose remote resolves empty, both rendered git_remote "_unattributed".)
        if (!args.includeUnattributed && !sessionIsAttributable(session.cwd)) {
          skippedUnattributed++;
          continue;
        }
        page = buildTranscriptPage(path, session);
        if (!sessionRepoAllowed(ctx, page.git_remote)) continue;
      } else {
        page = buildArtifactPage(path, type, raw);
      }
    } catch (err) {
      parseFailed++;
      console.error(`[parse-error] ${path}: ${(err as Error).message}`);
      continue;
    }

    const { body: renderedBody, sha: contentSha } = withContentHash(renderPageBody(page));

    // Optional belt-and-suspenders: when --scan-secrets is set, gitleaks the
    // rendered page — the exact bytes writeStaged() hands to gbrain — and
    // skip the file on any finding. Scanning the source file instead missed
    // secrets that JSON escaping hides from gitleaks' rules (`KEY=\"v\"` in
    // the .jsonl, `KEY="v"` in the page). A scan that could not run
    // (scanner "missing" or "error") skips the file too: the flag promises
    // nothing unscanned gets imported. Skipped files are not recorded in
    // state, so the next run retries them. Off by default because
    // gstack-brain-sync already gates the cross-machine boundary and
    // per-file gitleaks costs ~256ms/file (4-8 min on a real corpus).
    if (scanRenderedPages) {
      const scan = secretScanText(renderedBody);
      if (!scan.scanned || scan.scanner !== "gitleaks" || scan.findings.length > 0) {
        skippedSecret++;
        if (!args.quiet) {
          console.error(
            scan.scanner === "gitleaks"
              ? `[secret-scan match] ${path} (${scan.findings.length} finding${
                  scan.findings.length === 1 ? "" : "s"
                }); skipped`
              : `[secret-scan ${scan.scanner}] ${path} (gitleaks could not scan it); skipped`,
          );
        }
        continue;
      }
    }

    prepared.push({
      slug: page.slug,
      source_path: path,
      rendered_body: renderedBody,
      source_fingerprint: sourceFingerprint,
      content_sha256: contentSha,
      page_slug: page.slug,
      partial: page.partial ?? false,
      type,
      // Only transcripts carry a real remote; buildArtifactPage's git_remote
      // is a project slug, and artifacts are never policy-filtered (#2392).
      git_remote: type === "transcript" ? page.git_remote : undefined,
    });
  }

  // #2392: per-remote trust policy for transcript pages — the same store the
  // code-import gate honors (bin/gstack-gbrain-sync.ts). One batch spawn for
  // all distinct remotes in the run; no store on disk → zero policy work.
  // Runs AFTER the loop because preparePages accumulates fully in memory (no
  // writes happen until the caller stages), so filtering here is still
  // strictly before any write.
  let finalPrepared = prepared;
  let skippedPolicyReadonly = 0;
  let skippedPolicyDeny = 0;
  let policyError: string | undefined;
  if (policyStoreExists) {
    const remotes = [
      ...new Set(
        prepared
          .filter((p) => p.type === "transcript" && p.git_remote)
          .map((p) => p.git_remote as string),
      ),
    ];
    if (remotes.length > 0) {
      const verdicts = repoPolicyTierBatch(remotes);
      // The store EXISTS (checked above), so an unreadable/spawn-failed
      // result is a HARD ERROR — match the fail-closed polarity of
      // gstack-gbrain-sync's code-import gate: never bypass a set policy.
      const broken = remotes.find((r) => {
        const v = verdicts.get(r);
        return !v || v.error !== undefined;
      });
      if (broken) {
        const kind = verdicts.get(broken)?.error === "spawn-failed"
          ? "the policy helper could not be spawned (bash missing from PATH?)"
          : "the policy store could not be read (corrupt file?)";
        policyError =
          `repo policy store exists but ${kind} — refusing transcript ingest rather than ` +
          `bypassing a possibly-set deny policy. Inspect with: gstack-gbrain-repo-policy list; ` +
          `re-run /setup-gbrain if the store is corrupt.`;
      } else {
        finalPrepared = prepared.filter((p) => {
          if (p.type !== "transcript" || !p.git_remote) return true;
          const tier = verdicts.get(p.git_remote)?.tier ?? "none";
          if (tier === "read-only") {
            // Honoring an explicit user setting (search allowed, page writes
            // never) — transcript ingest writes pages, so skip.
            skippedPolicyReadonly++;
            return false;
          }
          if (tier === "deny") {
            skippedPolicyDeny++;
            return false;
          }
          return true; // read-write, or none (no policy set for this remote)
        });
      }
    }
  }

  // --limit applies AFTER policy filtering, over permitted pages only. In the
  // no-store fast path the walk already stopped at the limit, so this slice
  // is a no-op there.
  if (args.limit !== null && finalPrepared.length > args.limit) {
    finalPrepared = finalPrepared.slice(0, args.limit);
  }

  // Colliding path-derived slugs would overwrite in the staging dir, so two
  // source files land as one page and the staged-vs-collected guard fails the
  // whole batch every run (#2724: 887 staged → 0 ingested). Disambiguate
  // before staging, consulting state so assignments hold across runs.
  disambiguateSlugs(finalPrepared, state);
  ctx.scope.sessions_selected = finalPrepared.filter((p) => p.type === "transcript").length;

  // Derived from the FINAL set: partial counts must describe pages that are
  // actually eligible and within the limit, not the whole scanned corpus.
  partialPages = finalPrepared.filter((p) => p.partial).length;

  return {
    prepared: finalPrepared,
    skippedSecret,
    skippedDedup,
    skippedUnattributed,
    skippedPolicyReadonly,
    skippedPolicyDeny,
    parseFailed,
    partialPages,
    policyStoreExists,
    policyError,
  };
}

/**
 * Make a per-run staging directory at ~/.gstack/.staging-ingest-<pid>-<ts>/
 * The pid+ts namespace avoids collisions when two ingest passes run
 * concurrently (the orchestrator's lock should prevent this, but
 * defense-in-depth). A target gbrain source rides in the name as
 * `-src-<id>` so a resumed import (#1611) goes to the same source.
 */
function makeStagingDir(suffix = ""): string {
  const dir = join(GSTACK_HOME, `.staging-ingest-${process.pid}-${Date.now()}${suffix}`);
  mkdirSync(dir, { recursive: true });
  // Mint the ownership marker (#1802) so cleanupStagingDir() and decideResume()
  // can prove this dir was created by us before any recursive delete or resume.
  // #1802 C5: fail hard if the marker can't be written — a marker-less dir would
  // be refused by the guard forever (leaked, never cleaned). Tear down the
  // partial dir and rethrow so the caller fails loudly instead of leaking.
  try {
    writeFileSync(join(dir, STAGING_MARKER), `${process.pid}\n${Date.now()}\n`, "utf-8");
  } catch (err) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
    throw err;
  }
  return dir;
}

/**
 * Persistent staging dir used in remote-http MCP mode (split-engine D11).
 *
 * Instead of staging to ~/.gstack/.staging-ingest-<pid>-<ts>/ and cleaning up
 * after `gbrain import`, remote-http users get a stable path that survives.
 * gstack-brain-sync's allowlist pushes ~/.gstack/transcripts/** to the
 * artifacts repo; the brain admin's pull job indexes them into the remote
 * brain. Local PGLite (if present) stays code-only.
 *
 * Path: ~/.gstack/transcripts/<run-id>/  (run-id pid+ts so concurrent passes
 * stay separate; brain-sync push doesn't care about subdir naming).
 */
function makePersistentTranscriptDir(): string {
  const dir = join(
    GSTACK_HOME,
    "transcripts",
    `run-${process.pid}-${Date.now()}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Detect whether the gbrain MCP is remote-http (Path 4) — and therefore we
 * should NOT call `gbrain import` because we don't want the local PGLite
 * polluted with transcripts (per plan D11).
 *
 * Reads ~/.claude.json directly (same fallback chain as gstack-gbrain-detect
 * Tier 3). Cheap: one fs read, no fork-exec.
 */
function isRemoteHttpMcpMode(): boolean {
  const home = process.env.HOME || homedir();
  const claudeJsonPath = join(home, ".claude.json");
  if (!existsSync(claudeJsonPath)) return false;
  try {
    const parsed = JSON.parse(readFileSync(claudeJsonPath, "utf-8")) as {
      mcpServers?: {
        gbrain?: { type?: string; transport?: string; url?: string };
      };
    };
    const entry = parsed.mcpServers?.gbrain;
    if (!entry) return false;
    const mtype = entry.type || entry.transport || "";
    if (mtype === "url" || mtype === "http" || mtype === "sse") return true;
    if (entry.url) return true;
    return false;
  } catch {
    return false;
  }
}

/**
 * Best-effort recursive cleanup. Failures swallowed — at worst we leak a
 * staging dir to disk; the next run uses a new one and they age out via
 * normal disk hygiene. We deliberately do NOT crash the pipeline on
 * cleanup failure.
 */
function cleanupStagingDir(dir: string): void {
  // #1802 deletion chokepoint: never recurse-delete a path we cannot PROVE we
  // own. A poisoned resume could otherwise route the repo root here.
  const verdict = checkOwnedStagingDir(dir, GSTACK_HOME);
  if (!verdict.ok) {
    console.error(
      `[gbrain] staging cleanup REFUSED: "${dir}" is not an owned staging dir ` +
        `(${verdict.reason}). Skipping rm -rf to prevent data loss (#1802).`,
    );
    return;
  }
  try {
    // #1802 C5: delete the realpath-resolved dir the guard validated, not the
    // raw input — closes the TOCTOU gap where `dir` is a symlink swapped between
    // the check above and this rmSync. canonicalPath is always set when ok.
    rmSync(verdict.canonicalPath ?? dir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
}

/**
 * Track the currently-running gbrain import child + active staging dir so
 * SIGTERM/SIGINT on the parent process can:
 *   1. forward the signal to the child (otherwise gbrain orphans, holds the
 *      PGLite write lock, and burns CPU — observed during 2026-05-10 cold-run
 *      testing)
 *   2. PRESERVE the staging dir when gbrain has written an import-checkpoint
 *      pointing at it (the next /sync-gbrain run can resume from
 *      processedIndex+1). Otherwise synchronously clean up before
 *      process.exit, since `finally` blocks in ingestPass never run after
 *      process.exit fires from inside a signal handler.
 *
 * Resume semantics added for #1611: prior behavior unconditionally cleaned
 * up the staging dir on SIGTERM, so the gbrain checkpoint always pointed at
 * a missing dir and the next run had to restage from scratch.
 */
let _activeImportChild: ChildProcess | null = null;
let _activeStagingDir: string | null = null;
let _signalHandlersInstalled = false;

/**
 * Returns true if gbrain has written ~/.gbrain/import-checkpoint.json with
 * `dir` matching the current active staging dir. Indicates the next run
 * can resume against this staging dir.
 */
function stagingDirIsCheckpointed(stagingDir: string): boolean {
  try {
    // Read HOME from env so tests can redirect; homedir() caches.
    const home = process.env.HOME || homedir();
    const cpPath = join(home, ".gbrain", "import-checkpoint.json");
    if (!existsSync(cpPath)) return false;
    const raw = readFileSync(cpPath, "utf-8");
    const cp = JSON.parse(raw) as { dir?: string };
    return cp.dir === stagingDir;
  } catch {
    return false;
  }
}

function installSignalForwarder(): void {
  if (_signalHandlersInstalled) return;
  _signalHandlersInstalled = true;
  const forward = (signal: NodeJS.Signals) => () => {
    if (_activeImportChild && _activeImportChild.pid && !_activeImportChild.killed) {
      try {
        process.kill(_activeImportChild.pid, signal);
      } catch {
        // child may have already exited between the alive-check and the kill
      }
    }
    if (_activeStagingDir) {
      if (stagingDirIsCheckpointed(_activeStagingDir)) {
        // Preserve for next-run resume. The orchestrator's decideResume()
        // (in gstack-gbrain-sync.ts) will see the checkpoint + dir and
        // re-invoke gbrain import against this same staging dir, picking
        // up from processedIndex+1. See #1611.
        try {
          process.stderr.write(
            `[memory-ingest] ${signal} received — preserving staging dir for resume: ${_activeStagingDir}\n`,
          );
        } catch {
          // best-effort: stderr may be closed already
        }
      } else {
        // No checkpoint pointing here — the import never reached gbrain or
        // crashed before writing one. Clean up so we don't leak the dir.
        cleanupStagingDir(_activeStagingDir);
      }
      _activeStagingDir = null;
    }
    // Re-raise to default action so the parent actually exits. Without this,
    // a SIGTERM handler that doesn't exit holds the process alive.
    process.exit(signal === "SIGINT" ? 130 : 143);
  };
  process.on("SIGTERM", forward("SIGTERM"));
  process.on("SIGINT", forward("SIGINT"));
}

/**
 * Run gbrain import as an async child so we can install signal handlers
 * that kill the child on parent SIGTERM/SIGINT. Returns the same shape as
 * spawnSync's result so the caller doesn't care which mode was used.
 */
/**
 * #1611: the `gbrain import` is the long pole on big brains. Its timeout is
 * configurable via GSTACK_INGEST_TIMEOUT_MS (default 30 min, 1min–24h) so large
 * memory corpora aren't SIGTERM'd mid-import. On timeout we SIGTERM the child,
 * which preserves gbrain's import-checkpoint.json (see installSignalForwarder)
 * so the next run resumes instead of restarting from scratch.
 */
const DEFAULT_IMPORT_TIMEOUT_MS = 30 * 60 * 1000;
export function resolveImportTimeoutMs(
  raw: string | undefined = process.env.GSTACK_INGEST_TIMEOUT_MS,
): number {
  if (raw === undefined || raw === "") return DEFAULT_IMPORT_TIMEOUT_MS;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || Number.isNaN(n) || n < 60_000 || n > 86_400_000) {
    console.error(
      `[memory-ingest] GSTACK_INGEST_TIMEOUT_MS="${raw}" invalid (need 60000–86400000ms); using ${DEFAULT_IMPORT_TIMEOUT_MS}ms`,
    );
    return DEFAULT_IMPORT_TIMEOUT_MS;
  }
  return n;
}

/**
 * True when the import failed because the installed gbrain predates
 * --include-gitignored. gbrain's subcommand --help is generic (no flag list),
 * so the only reliable probe is the attempt itself.
 */
function failedOnUnknownIncludeGitignored(status: number | null, stderr: string): boolean {
  if (status === 0 || status === null) return false;
  return /(unknown|unexpected|unrecognized|invalid)[^\n]*--include-gitignored|--include-gitignored[^\n]*(unknown|unexpected|unrecognized|invalid)/i.test(
    stderr,
  );
}

async function runGbrainImport(
  stagingDir: string,
  timeoutMs: number,
  sourceId: string | null = null,
): Promise<{ status: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  const first = await runGbrainImportOnce(stagingDir, timeoutMs, true, sourceId);
  if (failedOnUnknownIncludeGitignored(first.status, first.stderr)) {
    // Older gbrain: retry without the flag. If .gitignore then hides the
    // staged pages, the imported<staged reconciliation guard below refuses
    // to advance state and names the remedy — loud failure, never silent
    // loss, and never a hard-block for gbrain versions that don't need the
    // flag's semantics.
    console.error(
      "[memory-ingest] installed gbrain does not support --include-gitignored — " +
        "retrying without it. If the import then collects 0 files, upgrade gbrain " +
        "(gstack-gbrain-install) so staged pages inside gitignored dirs are visible.",
    );
    return runGbrainImportOnce(stagingDir, timeoutMs, false, sourceId);
  }
  return first;
}

function runGbrainImportOnce(
  stagingDir: string,
  timeoutMs: number,
  includeGitignored: boolean,
  sourceId: string | null,
): Promise<{ status: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  installSignalForwarder();
  return new Promise((resolve) => {
    // Seed DATABASE_URL from gbrain's own config so this stage works
    // inside Next.js / Prisma / Rails projects with their own
    // .env.local (codex review #7 — defense in depth on top of the
    // parent gstack-gbrain-sync seeding the bun grandchild's env).
    // --include-gitignored is load-bearing, not a convenience. Pages are
    // staged into ~/.gstack/.staging-ingest-<pid>-<ts>/, and ~/.gstack is a
    // git repo whose .gitignore is `*`. `gbrain import` honours .gitignore,
    // so without this flag it collects files=0 and imports NOTHING, while
    // still reporting `written: N` from the staged count. Silent data loss
    // on every run. A working run logs `import.collect_files done ... files=N`
    // with N > 0 and takes minutes, not seconds.
    //
    // GIT_CEILING_DIRECTORIES is the second layer of the same #2144 defense:
    // it stops git's upward repo discovery at the staging dir's parent, so a
    // git-enumerating collector fails cleanly out of the git fast path and
    // falls back to its plain FS walk even on gbrain builds whose flag
    // semantics drift. The ceiling must be the REAL path — git compares
    // canonicalized directories during discovery, and a staging dir reached
    // through a symlink (macOS /var -> /private/var, symlinked $GSTACK_HOME)
    // otherwise never matches the ceiling entry. Scoped to this one child;
    // no on-disk state, staging-guard/resume contracts untouched.
    let ceiling: string;
    try {
      ceiling = realpathSync(dirname(stagingDir));
    } catch {
      ceiling = dirname(stagingDir); // staging parent vanished mid-run; spawn will fail loudly anyway
    }
    const baseEnv: NodeJS.ProcessEnv = {
      ...process.env,
      // path.delimiter, not ':' — git splits this on ';' on Windows, and
      // drive-letter paths contain ':' themselves.
      GIT_CEILING_DIRECTORIES: process.env.GIT_CEILING_DIRECTORIES
        ? `${ceiling}${delimiter}${process.env.GIT_CEILING_DIRECTORIES}`
        : ceiling,
    };
    const child = spawnGbrainAsync(
      [
        "import",
        stagingDir,
        "--no-embed",
        ...(includeGitignored ? ["--include-gitignored"] : []),
        ...(sourceId ? ["--source-id", sourceId] : []),
        "--json",
      ],
      { baseEnv },
    );
    _activeImportChild = child;
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (child.pid) process.kill(child.pid, "SIGTERM");
      } catch {
        // already gone
      }
    }, timeoutMs);
    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString("utf-8");
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString("utf-8");
    });
    child.on("close", (status) => {
      clearTimeout(timer);
      _activeImportChild = null;
      resolve({
        status: timedOut ? null : status,
        stdout,
        stderr,
        timedOut,
      });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      _activeImportChild = null;
      resolve({
        status: null,
        stdout,
        stderr: stderr + `\n[spawn-error] ${(err as Error).message}`,
        timedOut,
      });
    });
  });
}

async function ingestPass(args: CliArgs, state: IngestState): Promise<BulkResult> {
  const scope = emptyScopeCounts();
  return { ...(await ingestPassScoped(args, state, scope)), scope };
}

async function ingestPassScoped(args: CliArgs, state: IngestState, scope: TranscriptScopeCounts): Promise<BulkResult> {
  const t0 = Date.now();
  const ctx = makeWalkContext(args, state, scope);
  const remoteHttpMode = isRemoteHttpMcpMode();
  const resumeDir = process.env.GSTACK_INGEST_RESUME_DIR;
  const resuming = !args.noWrite && !remoteHttpMode
    && typeof resumeDir === "string"
    && resumeDir.length > 0
    && existsSync(resumeDir)
    && checkOwnedStagingDir(resumeDir, GSTACK_HOME).ok;

  // Phase 1: prepare (parse + render frontmatter + secret-scan + filter).
  const prep = preparePages(args, ctx, state, args.scanSecrets && !resuming);

  let written = 0;
  let failed = 0;

  // #2392 HARD ERROR: the policy store exists but could not be consulted.
  // Abort before ANY write — state recording, staging, gbrain import — so a
  // corrupt store can never silently bypass a set deny/read-only policy.
  if (prep.policyError) {
    console.error(`[memory-ingest] ERR: ${prep.policyError}`);
    return {
      state_untouched: true,
      written: 0,
      skipped_secret: prep.skippedSecret,
      skipped_dedup: prep.skippedDedup,
      skipped_unattributed: prep.skippedUnattributed,
      skipped_policy_readonly: prep.skippedPolicyReadonly,
      skipped_policy_deny: prep.skippedPolicyDeny,
      failed: prep.parseFailed + prep.prepared.length,
      duration_ms: Date.now() - t0,
      partial_pages: prep.partialPages,
      system_error: prep.policyError,
    };
  }

  if (args.noWrite) {
    // --no-write is a dry run: it prepares pages (so parse, attribution,
    // policy and scan results are reported) but neither imports nor touches
    // the state file. Stamping here marked every prepared page ingested, so
    // the next real run skipped them forever (A9).
    if (!args.quiet) {
      console.error(
        `[memory-ingest] --no-write: ${prep.prepared.length} page(s) would be imported; nothing was imported and the state file was not changed.`,
      );
    }
    return {
      state_untouched: true,
      written: 0,
      skipped_secret: prep.skippedSecret,
      skipped_dedup: prep.skippedDedup,
      skipped_unattributed: prep.skippedUnattributed,
      skipped_policy_readonly: prep.skippedPolicyReadonly,
      skipped_policy_deny: prep.skippedPolicyDeny,
      failed: prep.parseFailed,
      duration_ms: Date.now() - t0,
      partial_pages: prep.partialPages,
    };
  }

  if (prep.prepared.length === 0) {
    // Nothing to import — still touch state.last_full_walk, and re-check pages
    // an earlier run could not verify (A1: checked once a lookup works).
    state.last_full_walk = new Date().toISOString();
    state.last_writer = "gstack-memory-ingest";
    const hasUnverified = Object.values(state.sessions).some((e) => e.status === "imported_unverified");
    const check = hasUnverified && !remoteHttpMode && gbrainAvailable() ? verifyImported(state, new Set()) : null;
    return {
      ...(check ? { unverified: check.unverified, refused: check.requeued } : {}),
      written: 0,
      skipped_secret: prep.skippedSecret,
      skipped_dedup: prep.skippedDedup,
      skipped_unattributed: prep.skippedUnattributed,
      skipped_policy_readonly: prep.skippedPolicyReadonly,
      skipped_policy_deny: prep.skippedPolicyDeny,
      failed: prep.parseFailed,
      duration_ms: Date.now() - t0,
      partial_pages: prep.partialPages,
    };
  }

  if (!gbrainAvailable()) {
    const msg =
      "gbrain CLI not in PATH or missing `import` subcommand. Run /setup-gbrain.";
    console.error(`[memory-ingest] ERR: ${msg}`);
    return {
      state_untouched: true,
      written: 0,
      skipped_secret: prep.skippedSecret,
      skipped_dedup: prep.skippedDedup,
      skipped_unattributed: prep.skippedUnattributed,
      skipped_policy_readonly: prep.skippedPolicyReadonly,
      skipped_policy_deny: prep.skippedPolicyDeny,
      failed: prep.parseFailed + prep.prepared.length,
      duration_ms: Date.now() - t0,
      partial_pages: prep.partialPages,
      system_error: msg,
    };
  }

  // Phase 2: stage + import, verify, then stamp (A1, INV-2).
  //
  // Split-engine branch per plan D11: in remote-http MCP mode, we stage to a
  // PERSISTENT dir under ~/.gstack/transcripts/ and SKIP `gbrain import`
  // entirely. gstack-brain-sync push will pick the dir up via its allowlist
  // and the brain admin's pull job will index transcripts into the remote
  // brain. Such pages are recorded as `staged`, never `ingested`: this
  // machine cannot see whether the remote brain indexed them.
  //
  // Resume branch for #1611: when the orchestrator sets
  // GSTACK_INGEST_RESUME_DIR (because gbrain's import-checkpoint.json points
  // at an existing dir from a prior SIGTERM'd run), reuse that staging dir
  // and skip writeStaged. gbrain's checkpoint tells it where to resume.
  // #1802 second entry point: this binary is runnable directly, so it must not
  // trust GSTACK_INGEST_RESUME_DIR just because it exists — a stale/poisoned env
  // could make us `gbrain import` (and later clean up) an arbitrary directory.
  // Prove ownership here too, independently of the orchestrator's decideResume.
  if (!remoteHttpMode && resumeDir && resumeDir.length > 0 && !resuming) {
    console.error(
      `[memory-ingest] ignoring GSTACK_INGEST_RESUME_DIR="${resumeDir}" — not a proven staging dir (#1802); staging fresh.`,
    );
  }
  const base = {
    skipped_secret: prep.skippedSecret,
    skipped_dedup: prep.skippedDedup,
    skipped_unattributed: prep.skippedUnattributed,
    skipped_policy_readonly: prep.skippedPolicyReadonly,
    skipped_policy_deny: prep.skippedPolicyDeny,
    partial_pages: prep.partialPages,
    kept_local: 0,
  };

  // A4: unattributed transcripts stay on this machine when the brain is
  // remote, and never enter the publishable remote-http staging.
  const remoteBrain = brainIsRemote(remoteHttpMode);
  const keptLocal = remoteBrain ? prep.prepared.filter(isUnattributed) : [];
  if (keptLocal.length > 0) {
    reportPage(
      `kept ${keptLocal.length} unattributed transcript(s) on this machine: the brain is remote (Postgres or HTTP), ` +
        `and unattributed pages go only to the machine-local source ${UNATTRIBUTED_SOURCE_ID}.`,
    );
  }
  const toImport = keptLocal.length > 0 ? prep.prepared.filter((p) => !isUnattributed(p)) : prep.prepared;
  base.kept_local = keptLocal.length;

  if (remoteHttpMode) return stageForRemoteBrain(args, toImport, state, base, t0);

  const enforceResumePolicy = resuming && hasRepoPolicyStore();
  let resumed: PreStaged | undefined;
  if (resuming) {
    const r = verifyResumeDir(args, prep, resumeDir!, enforceResumePolicy);
    if ("error" in r) {
      return {
        state_untouched: true,
        ...base,
        written: 0,
        skipped_secret: prep.skippedSecret + (r.scannerFailed ? 1 : 0),
        failed: prep.parseFailed + prep.prepared.length,
        duration_ms: Date.now() - t0,
        system_error: r.error,
      };
    }
    resumed = r;
  }

  // Egress receipt BEFORE the import (fail-closed): the gbrain DB may be a
  // remote Postgres, so the ingest is a potential off-machine send. The
  // gbrain subprocess owns the wire bytes (content-free receipt, sha256
  // null). The remote-http branch above stages locally only — its egress
  // happens in gstack-brain-sync, which writes its own receipt at the push.
  try {
    writeReceipt({
      sink: "memory-ingest",
      host: "gbrain-db (user-configured DATABASE_URL)",
      payloadClass: `transcript-pages count=${resumed ? resumed.staged.size : toImport.length} (sent by gbrain subprocess)`,
      bytes: 0,
      sha256: null,
      consent: "gbrain setup consent (/setup-gbrain)",
    });
  } catch (err) {
    const msg = `EGRESS_RECEIPT_FAILED: ${(err as Error).message} — ingest refused`;
    console.error(`[memory-ingest] ERR: ${msg}`);
    if (resumed && !args.scanSecrets) cleanupStagingDir(resumed.stagingDir);
    return { ...base, state_untouched: true, written: 0, failed: prep.parseFailed + prep.prepared.length, duration_ms: Date.now() - t0, system_error: msg };
  }

  const run: RunContext = {
    args,
    state,
    nowIso: new Date().toISOString(),
    written: 0,
    failed: 0,
    refused: 0,
    quarantined: 0,
    importedThisRun: new Set(),
  };
  // D6: one batch import per gbrain source, sequentially (PGLite is a single
  // writer). `--no-embed` matches the prior per-file behavior; `--json` gives
  // structured counts and per-file failures.
  // A4: one partition per gbrain source; a transcript source is registered
  // (non-federated) before its first import, or its pages stay local.
  const listed: { ids: Set<string> | null } = { ids: null };
  for (const batch of resumed ? [{ sourceId: resumed.sourceId, pages: [...resumed.staged.values()] }] : planBatches(toImport, state)) {
    if (!resumed && batch.sourceId?.startsWith("gstack-transcripts")) {
      const repo = isUnattributed(batch.pages[0]) ? "(no repository)" : batch.pages[0].git_remote!;
      const why = ensureTranscriptSource(state, batch.sourceId, repo, listed);
      if (why) {
        base.kept_local += batch.pages.length;
        reportPage(`kept ${batch.pages.length} transcript page(s) for ${repo} on this machine: ${why}. They import once the source can be registered (upgrade gbrain with gstack-gbrain-install).`);
        continue;
      }
    }
    await importPartition(run, batch.pages, batch.sourceId, resumed);
    // Other sources still import after one source's import fails; only a
    // timeout (whose checkpoint a later import would overwrite) stops the run.
    if (run.stopImports) break;
  }

  // Landing check: confirm what this run (and earlier runs) imported is in
  // its recorded source before stamping it ingested. Bounded per run.
  const check = verifyImported(state, run.importedThisRun);
  run.written -= check.requeuedThisRun;
  run.refused += check.requeued;
  run.failed += check.requeued;

  state.last_full_walk = new Date().toISOString();
  state.last_writer = "gstack-memory-ingest";
  return {
    ...base,
    written: run.written,
    failed: run.failed + prep.parseFailed,
    refused: run.refused,
    unverified: check.unverified,
    quarantined: run.quarantined,
    duration_ms: Date.now() - t0,
    ...(run.systemError ? { system_error: run.systemError } : {}),
  };
}

interface PreStaged {
  stagingDir: string;
  sourceId: string | null;
  /** Staged rel path → the prepared page whose rendered body it holds. */
  staged: Map<string, PreparedPage>;
  /** Keep the dir when anything in it did not land (scanned or policy-checked resume). */
  preserveOnShortfall: boolean;
  /** Pages the import count is checked against (saved pages on a strict resume). */
  expected?: number;
}

interface RunContext {
  args: CliArgs;
  state: IngestState;
  nowIso: string;
  written: number;
  failed: number;
  refused: number;
  quarantined: number;
  importedThisRun: Set<string>;
  systemError?: string;
  /** A timed-out import may have left a gbrain checkpoint; no later import may overwrite it. */
  stopImports?: boolean;
}

/**
 * The gbrain source a page imports into (A4); null = gbrain's own default
 * routing, which curated artifacts keep. A page's recorded source is sticky:
 * pages stamped before per-repo sources existed ("default") keep going where
 * they went, so a source never gains a duplicate of an older page. New
 * transcripts go to their originating repository's own transcript source;
 * transcripts with no repository go to the machine-local unattributed source.
 */
function targetSource(p: PreparedPage, entry: StateEntry | undefined): string | null {
  if (entry && entry.source_id !== "remote-http") return entry.source_id === LEGACY_SOURCE_ID ? null : entry.source_id;
  if (p.type !== "transcript") return null;
  return isUnattributed(p) ? UNATTRIBUTED_SOURCE_ID : transcriptSourceId(p.git_remote!);
}

function isUnattributed(p: PreparedPage): boolean {
  return p.type === "transcript" && (!p.git_remote || p.git_remote === "_unattributed");
}

/** Per-repository transcript source id: gbrain-valid, stable per canonical remote. */
export function transcriptSourceId(remote: string): string {
  return constrainSourceId("gstack-transcripts", remote);
}

/**
 * The brain is remote when gbrain's config names a database URL (Postgres or
 * Supabase) or a remote MCP, or the agent host talks to a remote-HTTP brain.
 * Unattributed transcripts never leave the machine (A4).
 */
function brainIsRemote(remoteHttpMode: boolean): boolean {
  if (remoteHttpMode) return true;
  try {
    const cfg = JSON.parse(readFileSync(join(gbrainConfigDir(), "config.json"), "utf-8"));
    return (typeof cfg?.database_url === "string" && cfg.database_url.trim() !== "" && cfg.engine !== "pglite") || !!cfg?.remote_mcp;
  } catch {
    return false;
  }
}

/** Pages grouped by the gbrain source they import into, in first-seen order. */
function planBatches(pages: PreparedPage[], state: IngestState): Array<{ sourceId: string | null; pages: PreparedPage[] }> {
  const groups = new Map<string | null, PreparedPage[]>();
  for (const p of pages) {
    const id = targetSource(p, state.sessions[p.source_path]);
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id)!.push(p);
  }
  return [...groups].map(([sourceId, group]) => ({ sourceId, pages: group }));
}

/**
 * Register a transcript source before its first import: machine-local and
 * never federated. Registration is cached in state so it runs once per
 * repository. Returns null when the source is usable, else why it is not.
 */
function ensureTranscriptSource(
  state: IngestState,
  id: string,
  repo: string,
  listed: { ids: Set<string> | null },
): string | null {
  if (state.sources?.[id]) return null;
  if (!listed.ids) {
    const r = spawnGbrain(["sources", "list", "--json"], { timeout: 30_000 });
    let raw: unknown = null;
    try {
      raw = r.status === 0 ? JSON.parse(r.stdout || "null") : null;
    } catch {}
    listed.ids = new Set(parseSourcesList(raw).map((row) => row.id).filter((x): x is string => typeof x === "string"));
  }
  if (!listed.ids.has(id)) {
    const add = spawnGbrain(["sources", "add", id, "--no-federated", "--name", `gstack transcripts: ${repo}`], { timeout: 30_000 });
    if (add.status !== 0) {
      return `could not register gbrain source ${id} (${(add.stderr || add.stdout || `exit ${add.status}`).trim().split("\n")[0].slice(0, 200)})`;
    }
    listed.ids.add(id);
  }
  (state.sources ??= {})[id] = { repo, registered_at: new Date().toISOString() };
  return null;
}

/** Print even under --quiet: a page that did not land must never be silent (A1). */
function reportPage(msg: string): void {
  console.error(`[memory-ingest] ${msg}`);
}

function stampEntry(run: RunContext, p: PreparedPage, next: Pick<StateEntry, "status" | "source_id"> & Partial<StateEntry>): boolean {
  let fingerprint: SourceFingerprint | null;
  try {
    fingerprint = sourceFingerprintForStamp(p);
  } catch (err) {
    console.error(`[state-record] ${p.source_path}: ${(err as Error).message}`);
    return false;
  }
  // Changed since it was parsed: leave it for the next run, which sees the change.
  if (!fingerprint) return false;
  setEntry(run.state, p.source_path, {
    ...fingerprint,
    page_slug: p.page_slug,
    ...(p.partial ? { partial: true } : {}),
    content_sha256: p.content_sha256,
    ...next,
  });
  if (run.state.batch_refusals) delete run.state.batch_refusals[p.source_path];
  return true;
}

/**
 * Pages that did not land are never stamped: a new page keeps no entry and a
 * changed page keeps its previous one, so the next run retries both. A
 * whole-batch refusal is counted toward bisecting the batch.
 */
function markRefused(run: RunContext, pages: PreparedPage[], batchRefusal: boolean): void {
  run.refused += pages.length;
  if (!batchRefusal) return;
  const counts = (run.state.batch_refusals ??= {});
  for (const p of pages) counts[p.source_path] = (counts[p.source_path] ?? 0) + 1;
}

type BatchOutcome = { kind: "ok" } | { kind: "error" } | { kind: "refused"; pages: PreparedPage[]; reason: string; stagingDir: string };

/**
 * Import one partition. A batch refused as a whole (a failure gbrain did not
 * attribute to a page) is retried by later runs; after BISECT_AFTER_REFUSALS
 * refusals it is split in halves to isolate the page that poisons it.
 */
async function importPartition(run: RunContext, pages: PreparedPage[], sourceId: string | null, pre?: PreStaged): Promise<void> {
  const outcome = await importAndApply(run, pages, sourceId, pre);
  if (outcome.kind !== "refused") return;
  const refusals = 1 + Math.max(0, ...outcome.pages.map((p) => run.state.batch_refusals?.[p.source_path] ?? 0));
  if (!pre && refusals >= BISECT_AFTER_REFUSALS) {
    reportPage(`batch of ${outcome.pages.length} page(s) refused ${refusals} times (${outcome.reason}); importing it in halves to find the page gbrain cannot take`);
    await isolatePoisonPage(run, outcome.pages, sourceId, outcome.reason);
    return;
  }
  markRefused(run, outcome.pages, true);
  run.systemError ??=
    `${outcome.reason}. Refusing to advance state — the unaccounted pages would be marked ingested without ` +
    `landing in the brain. If the count is 0, check whether ${outcome.stagingDir} is inside a git ` +
    `repo that ignores it (gbrain import honours .gitignore).`;
  console.error(`[memory-ingest] ERR: ${run.systemError}`);
}

async function isolatePoisonPage(run: RunContext, group: PreparedPage[], sourceId: string | null, reason: string): Promise<void> {
  if (group.length === 1) {
    const p = group[0];
    if (stampEntry(run, p, { status: "quarantined", source_id: sourceId ?? LEGACY_SOURCE_ID, reason: `refused alone: ${reason}` })) run.quarantined++;
    reportPage(`quarantined ${p.page_slug} (${p.source_path}): gbrain refuses every batch that contains it (${reason}). It is retried when the source file changes.`);
    return;
  }
  const mid = Math.ceil(group.length / 2);
  const refusedHalves: Array<{ pages: PreparedPage[]; reason: string }> = [];
  for (const half of [group.slice(0, mid), group.slice(mid)]) {
    const outcome = await importAndApply(run, half, sourceId);
    if (outcome.kind === "error") return;
    if (outcome.kind === "refused") refusedHalves.push(outcome);
  }
  if (refusedHalves.length === 2) {
    markRefused(run, group, true);
    run.systemError ??= `${reason}; both halves of the batch were refused too, so no single page is to blame. Refusing to advance state.`;
    console.error(`[memory-ingest] ERR: ${run.systemError}`);
    return;
  }
  if (refusedHalves.length === 1) await isolatePoisonPage(run, refusedHalves[0].pages, sourceId, refusedHalves[0].reason);
}

/** Stage, import and apply named failures and landings; a whole-batch refusal is returned to the caller. */
async function importAndApply(run: RunContext, pages: PreparedPage[], sourceId: string | null, pre?: PreStaged): Promise<BatchOutcome> {
  const { args } = run;
  const r = await importBatch(args, pages, sourceId, pre);
  run.failed += r.stageErrors;
  if (r.systemError) {
    // A source removed outside gstack: forget the cached registration so the
    // next run registers it again.
    if (sourceId && run.state.sources?.[sourceId] && /source/i.test(r.systemError) && /not found|unknown|does not exist/i.test(r.systemError)) {
      delete run.state.sources[sourceId];
    }
    run.systemError ??= r.systemError;
    if (r.timedOut) run.stopImports = true;
    run.failed += r.staged.size;
    return { kind: "error" };
  }
  const report = r.report!;
  const verdict = r.verdict!;
  const recordedSource = report.source_id ?? sourceId ?? LEGACY_SOURCE_ID;
  if (verdict.refuseAll) return { kind: "refused", pages: [...r.staged.values()], reason: verdict.refuseAll, stagingDir: r.stagingDir };

  for (const [rel, error] of verdict.named) {
    const p = r.staged.get(rel)!;
    run.failed++;
    markRefused(run, [p], false);
    reportPage(`FAILED ${rel}: ${error.slice(0, 300)} (left un-stamped; retried next run)`);
  }
  let stamped = 0;
  for (const [rel, p] of r.staged) {
    if (verdict.named.has(rel)) continue;
    if (!stampEntry(run, p, { status: "imported_unverified", source_id: recordedSource, ingested_at: run.nowIso, reason: undefined })) continue;
    run.written++;
    stamped++;
    run.importedThisRun.add(p.source_path);
    if (!args.quiet) console.log(`[${run.written}] ${p.page_slug}${p.partial ? " [partial]" : ""}`);
  }
  // A scanned or policy-checked resume keeps its saved stage until every
  // saved page landed and was stamped.
  if (pre?.preserveOnShortfall && stamped >= (pre.expected ?? r.staged.size) && verdict.named.size === 0) {
    cleanupStagingDir(pre.stagingDir);
  }
  if (!args.quiet) {
    console.error(
      `[memory-ingest] gbrain import: ${report.imported ?? 0} imported, ` +
        `${report.unchanged ?? report.skipped ?? 0} unchanged, ${verdict.named.size} failed` +
        (verdict.named.size > 0 ? " (named above; retried next run)" : ""),
    );
  }
  // Silent-zero pathology detector (#2144's other half): pages were staged
  // but NOTHING imported or skipped-as-unchanged. That shape hid the dead
  // ingest for months — it must be loud even under --quiet.
  if (r.staged.size > 0 && (report.imported ?? 0) + (report.skipped ?? 0) === 0 && (report.errors ?? 0) === 0) {
    console.error(
      `[memory-ingest] WARNING: ${r.staged.size} page(s) staged but gbrain collected ZERO ` +
        `(no imports, no unchanged-skips, no errors). This is the #2144 silent-zero shape — ` +
        `check gbrain's import.collect_files log line and your gbrain version.`,
    );
  }
  return { kind: "ok" };
}

interface BatchRun {
  staged: Map<string, PreparedPage>;
  stagingDir: string;
  stageErrors: number;
  timedOut?: boolean;
  report?: ImportReport;
  verdict?: BatchVerdict;
  systemError?: string;
}

async function importBatch(args: CliArgs, pages: PreparedPage[], sourceId: string | null, pre?: PreStaged): Promise<BatchRun> {
  const stagingDir = pre?.stagingDir ?? makeStagingDir(sourceId ? `-src-${sourceId}` : "");
  // Register staging dir with the signal forwarder so SIGTERM/SIGINT can
  // either preserve (when gbrain checkpointed it) or synchronously clean up.
  _activeStagingDir = stagingDir;
  // #1802 C3: set when the import-timeout branch leaves a resumable checkpoint
  // pointing at this staging dir, so the finally preserves it for the next run.
  let preserveStaging = !!pre?.preserveOnShortfall && args.scanSecrets;
  let staged: Map<string, PreparedPage>;
  let stageErrors = 0;
  try {
    if (pre) {
      staged = pre.staged;
      if (!args.quiet) console.error(`[memory-ingest] resuming previous staging dir ${stagingDir} (skipping prepare phase)`);
    } else {
      const staging = writeStaged(pages, stagingDir, args.scanSecrets);
      stageErrors = staging.errors.length;
      if (!args.quiet) for (const e of staging.errors.slice(0, 5)) console.error(`[stage-error] ${e.slug}: ${e.error}`);
      staged = new Map(pages
        .filter((p) => staging.stagedPathToSource.get(stagedRelPath(p.slug)) === p.source_path)
        .map((p) => [stagedRelPath(p.slug), p]));
      if (!args.quiet) console.error(`[memory-ingest] staged ${staged.size} pages → ${stagingDir}; running gbrain import...`);
    }

    // D7: snapshot sync-failures.jsonl byte-offset before import so we
    // can read only newly-appended failure entries afterwards.
    const syncFailuresPath = join(homedir(), ".gbrain", "sync-failures.jsonl");
    let preImportOffset = 0;
    try {
      if (existsSync(syncFailuresPath)) preImportOffset = statSync(syncFailuresPath).size;
    } catch {
      // best-effort; absent file → 0 offset
    }

    const importResult = await runGbrainImport(stagingDir, resolveImportTimeoutMs(), sourceId);
    const stdout = importResult.stdout || "";
    const stderr = importResult.stderr || "";
    const report = parseImportReport(stdout);
    // A non-zero exit WITH a --json summary is a partial failure (gbrain
    // exits 1 when any file throws): fall through to per-file accounting.
    if (importResult.status !== 0 && (report === null || importResult.timedOut)) {
      // #1611/#1802 C3: an INTERNAL timeout never signals the parent, so the
      // SIGTERM forwarder's preserve branch doesn't run. Preserve only when
      // gbrain actually checkpointed against this dir.
      if (importResult.timedOut) {
        const mins = Math.round(resolveImportTimeoutMs() / 60000);
        const checkpointed = stagingDirIsCheckpointed(stagingDir);
        if (checkpointed) preserveStaging = true;
        const msg = checkpointed
          ? `gbrain import timed out after ${mins}min; checkpoint preserved — re-run ` +
            `/sync-gbrain to resume (raise GSTACK_INGEST_TIMEOUT_MS for big brains)`
          : `gbrain import timed out after ${mins}min before writing a checkpoint; ` +
            `re-run /sync-gbrain to restage (raise GSTACK_INGEST_TIMEOUT_MS for big brains)`;
        console.error(`[memory-ingest] ${msg}`);
        return { staged, stagingDir, stageErrors, systemError: msg, timedOut: true };
      }
      const tail = (stderr.trim().split("\n").pop() || "").slice(0, 300);
      const msg = `gbrain import exited ${importResult.status}: ${tail}`;
      console.error(`[memory-ingest] ERR: ${msg}`);
      return { staged, stagingDir, stageErrors, systemError: msg };
    }
    if (!args.quiet) process.stderr.write(stderr);
    if (report === null) {
      // Silent zeros would let a future gbrain-output regression mask data loss.
      const msg = "gbrain import exited 0 but emitted no parseable --json payload. Refusing to advance state.";
      console.error(`[memory-ingest] ERR: ${msg}`);
      return { staged, stagingDir, stageErrors, systemError: msg };
    }
    const sourceToRel = new Map([...staged].map(([rel, p]) => [p.source_path, rel]));
    const sourcePathByRel = new Map([...staged].map(([rel, p]) => [rel, p.source_path]));
    const ledger = [...readNewFailures(syncFailuresPath, preImportOffset, sourcePathByRel)].map((src) => sourceToRel.get(src)!);
    const verdict = classifyImport(report, stderr, ledger, new Set(staged.keys()), pre?.expected);
    // The caller decides after stamping (importAndApply).
    if (pre?.preserveOnShortfall && !verdict.refuseAll) preserveStaging = true;
    return { staged, stagingDir, stageErrors, report, verdict };
  } finally {
    if (!preserveStaging) cleanupStagingDir(stagingDir);
    _activeStagingDir = null;
  }
}

/**
 * Remote-http mode: write pages to the persistent transcript dir that
 * gstack-brain-sync pushes and record them as `staged`.
 */
function stageForRemoteBrain(
  args: CliArgs,
  pages: PreparedPage[],
  state: IngestState,
  base: Omit<BulkResult, "written" | "failed" | "duration_ms">,
  t0: number,
): BulkResult {
  const dir = makePersistentTranscriptDir();
  const staging = writeStaged(pages, dir, args.scanSecrets);
  if (!args.quiet) {
    for (const e of staging.errors.slice(0, 5)) console.error(`[stage-error] ${e.slug}: ${e.error}`);
    console.error(
      `[memory-ingest] staged ${staging.written} pages → ${dir}; persisting to artifacts pipeline (skipping local gbrain import — remote-http mode)...`,
    );
  }
  const nowIso = new Date().toISOString();
  let written = 0;
  for (const p of pages) {
    if (staging.stagedPathToSource.get(stagedRelPath(p.slug)) !== p.source_path) continue;
    let fingerprint: SourceFingerprint | null;
    try {
      fingerprint = sourceFingerprintForStamp(p);
    } catch (err) {
      console.error(`[state-record] ${p.source_path}: ${(err as Error).message}`);
      continue;
    }
    if (!fingerprint) continue;
    setEntry(state, p.source_path, {
      ...fingerprint,
      page_slug: p.page_slug,
      ...(p.partial ? { partial: true } : {}),
      status: "staged",
      source_id: "remote-http",
      content_sha256: p.content_sha256,
      ingested_at: nowIso,
    });
    written++;
  }
  state.last_full_walk = nowIso;
  state.last_writer = "gstack-memory-ingest (remote-http mode)";
  if (!args.quiet) {
    console.error(`[memory-ingest] persisted ${written} pages to ${dir} (brain admin will index on next pull)`);
  }
  return { ...base, written, failed: staging.errors.length, duration_ms: Date.now() - t0 };
}

/**
 * Resume (#1611): validate the saved stage and map its pages back to their
 * sources. With --scan-secrets every saved file is rescanned; with a repo
 * policy store every saved page must be a current permitted source.
 */
function verifyResumeDir(
  args: CliArgs,
  prep: ReturnType<typeof preparePages>,
  stagingDir: string,
  enforceResumePolicy: boolean,
): PreStaged | { error: string; scannerFailed: boolean } {
  const staged = new Map<string, PreparedPage>();
  const stagedPagePaths = new Set<string>();
  const strict = args.scanSecrets || enforceResumePolicy;
  try {
    if (enforceResumePolicy && !prep.policyStoreExists) {
      throw new Error("[repo policy] policy store appeared after source preparation");
    }
    const eligiblePages = new Map(prep.prepared.map((p) => [stagedRelPath(p.slug), p]));
    const pending = [stagingDir];
    while (pending.length > 0) {
      const dir = pending.pop()!;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) pending.push(path);
        else if (entry.isFile()) {
          if (path === join(stagingDir, STAGING_MARKER)) continue;
          if (args.scanSecrets) {
            const scan = secretScanFile(path);
            if (!scan.scanned || scan.scanner !== "gitleaks" || scan.findings.length > 0) {
              const reason = scan.scanned ? "match" : scan.scanner;
              throw new Error(`[secret-scan ${reason}] ${path}`);
            }
          }
          if (entry.name.endsWith(".md")) {
            const relPath = relative(stagingDir, path).split("\\").join("/");
            stagedPagePaths.add(relPath);
            const page = eligiblePages.get(relPath);
            const current = !!page && readFileSync(path, "utf-8") === page.rendered_body;
            if (enforceResumePolicy && !current) {
              throw new Error(`[repo policy] staged page is not a current permitted source: ${relPath}`);
            }
            if (current || (!strict && page)) staged.set(relPath, page!);
          } else if (enforceResumePolicy) {
            throw new Error(`[repo policy] unrecognized staged file: ${path}`);
          }
        } else if (strict) {
          throw new Error(`[${args.scanSecrets ? "secret-scan error" : "repo policy"}] unsupported staging entry: ${path}`);
        }
      }
    }
    if (strict && stagedPagePaths.size === 0) {
      throw new Error(`[${args.scanSecrets ? "secret-scan error" : "repo policy"}] resumed staging contains no pages`);
    }
  } catch (err) {
    const cause = (err as Error).message;
    const scannerFailed = cause.startsWith("[secret-scan");
    const msg = `${cause}; resumed import refused. Staging preserved; ` +
      (scannerFailed
        ? "repair gitleaks and retry, or rerun without resume to restage."
        : "rerun without resume to restage under the current repo policy.");
    console.error(`[memory-ingest] ERR: ${msg}`);
    return { error: msg, scannerFailed };
  }
  const m = basename(stagingDir).match(/-src-([a-z0-9-]+)$/);
  return {
    stagingDir,
    sourceId: m ? m[1] : null,
    staged,
    preserveOnShortfall: strict,
    // gbrain's count covers every saved page, not only the ones still mapped.
    expected: strict ? stagedPagePaths.size : undefined,
  };
}

/**
 * Landing check over imported_unverified entries, this run's first. Present
 * with a matching gstack_content_sha256 → ingested. Missing or different →
 * refused (re-queued), printed even under --quiet; a page whose source file
 * is gone becomes unrecoverable. Lookup errors leave the entry unverified.
 * Returns how many entries remain unverified and how many were re-queued.
 */
function verifyImported(state: IngestState, importedThisRun: Set<string>): { unverified: number; requeued: number; requeuedThisRun: number } {
  const out = { unverified: 0, requeued: 0, requeuedThisRun: 0 };
  const nowIso = new Date().toISOString();
  const paths = Object.keys(state.sessions)
    .filter((p) => state.sessions[p].status === "imported_unverified")
    .sort((a, b) => Number(importedThisRun.has(b)) - Number(importedThisRun.has(a)));
  if (paths.length === 0) return out;
  const lookups: LandingLookups = gbrainLookups((a) => {
    const r = spawnGbrain(a, { timeout: 60_000 });
    return { status: r.status, stdout: r.stdout || "", stderr: r.stderr || "" };
  });
  const budget = { gets: DEFAULT_GET_CAP };
  for (const path of paths) {
    const entry = state.sessions[path];
    const outcome = checkLanding(entry, lookups, budget);
    if (outcome === "unchecked") {
      out.unverified++;
      continue;
    }
    if (outcome === "ingested") {
      setEntry(state, path, { ...entry, status: "ingested", verified_at: nowIso });
      continue;
    }
    const why = outcome === "absent"
      ? `not found in gbrain source ${entry.source_id} after import`
      : "gbrain holds different content than the staged page";
    if (!existsSync(path)) {
      setEntry(state, path, { ...entry, status: "unrecoverable", reason: `${why}; source file is gone` });
      reportPage(`unrecoverable ${entry.page_slug}: ${why}, and ${path} no longer exists`);
      continue;
    }
    setEntry(state, path, { ...entry, status: "refused", reason: why });
    out.requeued++;
    if (importedThisRun.has(path)) out.requeuedThisRun++;
    reportPage(`re-queued ${entry.page_slug}: ${why} (retried next run)`);
  }
  return out;
}

// ── Output formatting ──────────────────────────────────────────────────────

function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)}GB`;
}

function printProbeReport(r: ProbeReport, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(r, null, 2));
    return;
  }
  console.log("Memory ingest probe");
  console.log("───────────────────");
  console.log(`Total files in window: ${r.total_files}`);
  console.log(`Total bytes:           ${formatBytes(r.total_bytes)}`);
  console.log(`New (never ingested):  ${r.new_count}`);
  console.log(`Updated (mtime/hash):  ${r.updated_count}`);
  console.log(`Unchanged:             ${r.unchanged_count}`);
  if (r.skipped_unattributed > 0) {
    console.log(`Skipped (unattributed): ${r.skipped_unattributed}  (no git remote; use --include-unattributed to include)`);
  }
  if (r.skipped_policy_deny > 0) {
    console.log(`Skipped (policy deny):  ${r.skipped_policy_deny}  (remote tier is deny; change with: gstack-gbrain-repo-policy set <remote> read-write)`);
  }
  if (r.skipped_policy_readonly > 0) {
    console.log(`Skipped (policy read-only): ${r.skipped_policy_readonly}  (remote tier is read-only; transcript ingest writes pages)`);
  }
  for (const line of scopeLines(r.scope)) console.log(line);
  console.log("By type:");
  for (const [t, v] of Object.entries(r.by_type)) {
    if (v.count > 0) {
      console.log(`  ${t.padEnd(24)} ${String(v.count).padStart(6)} files  ${formatBytes(v.bytes).padStart(8)}`);
    }
  }
  console.log(`\nEstimate: ~${r.estimate_minutes} min for full --bulk pass.`);
}

/** Exclusion counts by reason; nothing when consent has no cutoff or allowlist. */
function scopeLines(scope: TranscriptScopeCounts | undefined, indent = ""): string[] {
  if (!scope) return [];
  const lines: string[] = [];
  if (scope.pre_cutoff > 0) lines.push(`${indent}Excluded (pre-cutoff):     ${scope.pre_cutoff}  (session started before the new@ cutoff)`);
  if (scope.missing_start > 0) lines.push(`${indent}Excluded (missing start):  ${scope.missing_start}  (no start timestamp; excluded under new@)`);
  if (scope.not_allowlisted > 0) lines.push(`${indent}Excluded (not allowlisted): ${scope.not_allowlisted}  (repo not in transcript_repos)`);
  return lines;
}

/**
 * Under a new@ cutoff, a run that selects no session says so, so "nothing
 * happened" reads as expected rather than broken.
 */
function zeroSessionsNotice(r: BulkResult, args: CliArgs): string | null {
  const consent = readIngestConsent();
  if (!consent.cutoff || !args.sources.has("transcript") || !r.scope || r.scope.sessions_selected > 0) return null;
  return `[memory-ingest] 0 transcript sessions ingested under new@${consent.cutoff}: ${r.scope.pre_cutoff} started before the cutoff; new sessions will appear on the next sync`;
}

function printBulkResult(r: BulkResult, args: CliArgs): void {
  console.log(`\nIngest pass complete (${args.mode}):`);
  console.log(`  written:               ${r.written}`);
  console.log(`  partial_pages:         ${r.partial_pages}  (will overwrite on next pass)`);
  console.log(`  skipped (dedup):       ${r.skipped_dedup}`);
  console.log(`  skipped (secret-scan): ${r.skipped_secret}`);
  console.log(`  skipped (unattrib):    ${r.skipped_unattributed}`);
  if (r.skipped_policy_readonly > 0) {
    console.log(`  skipped (policy read-only): ${r.skipped_policy_readonly}  (remote tier is read-only; transcript ingest writes pages)`);
  }
  if (r.skipped_policy_deny > 0) {
    console.log(`  skipped (policy deny):      ${r.skipped_policy_deny}  (change with: gstack-gbrain-repo-policy set <remote> read-write)`);
  }
  for (const line of scopeLines(r.scope, "  ")) console.log(line);
  console.log(`  failed:                ${r.failed}`);
  if (r.refused) console.log(`  refused (retry next run): ${r.refused}`);
  if (r.unverified) console.log(`  imported, not yet verified: ${r.unverified}  (checked on later runs)`);
  if (r.quarantined) console.log(`  quarantined:           ${r.quarantined}  (retried when the source changes)`);
  if (r.kept_local) console.log(`  kept local:            ${r.kept_local}  (see messages above)`);
  console.log(`  duration:              ${(r.duration_ms / 1000).toFixed(1)}s`);
  if (args.benchmark) {
    const pps = r.duration_ms > 0 ? (r.written * 1000) / r.duration_ms : 0;
    console.log(`  throughput:            ${pps.toFixed(2)} pages/sec`);
  }
}

// ── Entry point ────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs();

  // Recording a pending reconcile never calls gbrain (setup and upgrade
  // migrations use it), so it runs before engine detection.
  if (!args.requestReconcile) {
    // Engine tier detection — informational; routing happens in gbrain server-side.
    const engine = detectEngineTier();
    if (!args.quiet) {
      console.error(`[engine] ${engine.engine}${engine.engine === "supabase" ? ` (${engine.supabase_url || "configured"})` : ""}`);
    }
  }

  if (args.mode === "probe") {
    const report = await probeMode(args);
    printProbeReport(report, false);
    return;
  }

  // One lock for every state writer: ingest, reconcile, the pending flag (A1).
  const lock = acquireStateLock(LOCK_PATH);
  if (!lock.ok) {
    console.error(
      `[memory-ingest] ERR: another memory ingest (pid ${lock.holder}) is writing ${STATE_PATH}; not run. ` +
        `Fix: wait for it to finish, then re-run /sync-gbrain.`,
    );
    process.exit(1);
  }
  let code: number;
  try {
    code = await runLocked(args);
  } finally {
    lock.release();
  }
  if (code !== 0) process.exit(code);
}

async function runLocked(args: CliArgs): Promise<number> {
  // Tightening a scoped consent removes unpublished staged pages outside it and
  // their fingerprints, BEFORE the state loads, so a later widening re-stages.
  if (!args.noWrite && !args.requestReconcile && args.mode !== "reconcile") {
    const purged = purgeStagedTranscripts(GSTACK_HOME, readIngestConsent());
    if (purged > 0) console.error(`[memory-ingest] removed ${purged} staged transcript pages outside the new scope`);
  }
  const state = loadState();
  const save = (): boolean => {
    try {
      saveState(state);
      return true;
    } catch (err) {
      console.error(`[memory-ingest] ERR: ${(err as Error).message}. Nothing this run did is recorded; it will be redone next run.`);
      return false;
    }
  };

  if (args.requestReconcile) {
    state.reconcile = { ...state.reconcile, pending: true };
    if (!save()) return 1;
    if (!args.quiet) console.error("[memory-ingest] reconcile pending: the next ingest run re-checks stamped pages (one bounded pass).");
    return 0;
  }

  if (args.mode === "reconcile") {
    const status = reconcilePass(args, state, args.dryRun);
    if (status !== 0 || args.dryRun) return status;
    return save() ? 0 : 1;
  }

  const t0 = Date.now();
  const result = await ingestPass(args, state);
  if (!result.state_untouched) {
    // A pending reconcile (set by the upgrade migration or a schema migration)
    // gets one bounded pass per ingest run until it completes.
    if (!result.system_error && state.reconcile?.pending && !isRemoteHttpMcpMode()) reconcilePass(args, state, false);
    if (!save()) return 1;
  }

  if (args.mode === "incremental" && args.quiet) {
    // Steady-state fast path: log nothing unless changes happen.
    if (result.written > 0 || result.failed > 0) {
      console.error(`[memory-ingest] ${result.written} written, ${result.failed} failed in ${Date.now() - t0}ms`);
    }
  } else {
    printBulkResult(result, args);
  }
  const zero = zeroSessionsNotice(result, args);
  if (zero) console.error(zero);
  // D6: system_error → process-level failure; orchestrator sees ERR.
  // Per-file failures do NOT exit non-zero; they are printed and retried.
  return result.system_error ? 1 : 0;
}

/**
 * One bounded reconcile pass (A1). The summary prints even under --quiet.
 * The state file is backed up before the first change.
 */
function reconcilePass(args: CliArgs, state: IngestState, dryRun: boolean): number {
  if (isRemoteHttpMcpMode()) {
    console.error("[memory-ingest] reconcile: not run (remote-http brain: pages are staged for the brain admin's pull, not imported here).");
    return 0;
  }
  if (!gbrainAvailable()) {
    console.error("[memory-ingest] reconcile: not run (gbrain CLI not in PATH or missing `import`). Fix: run /setup-gbrain, then gstack-memory-ingest --reconcile.");
    return 1;
  }
  if (!dryRun) backupStateFile(STATE_PATH, `${STATE_PATH}.pre-reconcile.bak`);
  const lookups = gbrainLookups((a) => {
    const r = spawnGbrain(a, { timeout: 60_000 });
    return { status: r.status, stdout: r.stdout || "", stderr: r.stderr || "" };
  });
  const summary = reconcile(state, lookups, {
    limit: args.mode === "reconcile" && args.limit !== null ? args.limit : DEFAULT_RECONCILE_LIMIT,
    dryRun,
    fileExists: existsSync,
  });
  console.error(`[memory-ingest] ${formatReconcileSummary(summary, dryRun)}`);
  return 0;
}

// Guard so the module is import-safe for unit tests (e.g. resolveImportTimeoutMs).
// The orchestrator runs it as `bun gstack-memory-ingest.ts ...`, where
// import.meta.main is true, so the CLI path is unaffected.
if (import.meta.main) {
  main().catch((err) => {
    console.error(`gstack-memory-ingest fatal: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
