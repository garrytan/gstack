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
 * Secret scanning: gitleaks via lib/gstack-memory-helpers#secretScanFile (D19).
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
  appendFileSync,
  renameSync,
  openSync,
  readSync,
  closeSync,
  rmSync,
  realpathSync,
} from "fs";
import { join, basename, dirname, delimiter } from "path";
import { execFileSync, spawnSync, spawn, type ChildProcess } from "child_process";
import { homedir } from "os";
import { createHash } from "crypto";

import {
  canonicalizeRemote,
  secretScanFile,
  detectEngineTier,
  withErrorContext,
} from "../lib/gstack-memory-helpers";
import { execGbrainText, spawnGbrainAsync } from "../lib/gbrain-exec";
import { writeReceipt } from "../lib/egress-receipt";
import { checkOwnedStagingDir, STAGING_MARKER } from "../lib/staging-guard";
import { hasRepoPolicyStore, repoPolicyTierBatch } from "../lib/gbrain-repo-policy-client";

// ── Types ──────────────────────────────────────────────────────────────────

type Mode = "probe" | "incremental" | "bulk";

interface CliArgs {
  mode: Mode;
  quiet: boolean;
  benchmark: boolean;
  includeUnattributed: boolean;
  allHistory: boolean;
  sources: Set<MemoryType>;
  limit: number | null;
  noWrite: boolean;
  /**
   * Opt-in per-file gitleaks scan during the prepare phase. Off by
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

interface IngestState {
  schema_version: 1;
  last_writer: string;
  last_full_walk?: string;
  sessions: Record<
    string,
    {
      mtime_ns: number;
      sha256: string;
      ingested_at: string;
      page_slug: string;
      partial?: boolean;
    }
  >;
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
const GSTACK_HOME = process.env.GSTACK_HOME || join(HOME, ".gstack");
const STATE_PATH = join(GSTACK_HOME, ".transcript-ingest-state.json");
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

// ── CLI ────────────────────────────────────────────────────────────────────

function printUsage(): void {
  console.error(`Usage: gstack-memory-ingest [--probe|--incremental|--bulk] [options]

Modes:
  --probe              Count what would ingest; no writes. Fastest.
  --incremental        Default. mtime fast-path; only walks changed files.
  --bulk               First-run; full walk; gates on permission elsewhere.

Options:
  --quiet              Suppress per-file output (still prints summary).
  --benchmark          Time the run; report bytes-per-second + total.
  --include-unattributed  Ingest sessions with no resolvable git remote.
  --all-history        Walk transcripts older than 90 days too.
  --sources <list>     Comma-separated subset: ${ALL_TYPES.join(",")}
  --limit <N>          Stop after N pages written (smoke testing).
  --no-write           Skip gbrain put calls (still updates state file).
                       Used by tests + dry runs without actual ingest.
  --scan-secrets       Opt-in per-file gitleaks scan during prepare. Off by
                       default; gstack-brain-sync already gates the git-push
                       boundary. Adds ~4-8 min to cold runs.
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
  let noWrite = process.env.GSTACK_MEMORY_INGEST_NO_WRITE === "1";
  let scanSecrets = process.env.GSTACK_MEMORY_INGEST_SCAN_SECRETS === "1";

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    switch (a) {
      case "--probe": mode = "probe"; break;
      case "--incremental": mode = "incremental"; break;
      case "--bulk": mode = "bulk"; break;
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

  return { mode, quiet, benchmark, includeUnattributed, allHistory, sources, limit, noWrite, scanSecrets };
}

// ── State file ─────────────────────────────────────────────────────────────

function loadState(): IngestState {
  if (!existsSync(STATE_PATH)) {
    return {
      schema_version: 1,
      last_writer: "gstack-memory-ingest",
      sessions: {},
    };
  }
  try {
    const raw = readFileSync(STATE_PATH, "utf-8");
    const parsed = JSON.parse(raw) as IngestState;
    if (parsed.schema_version !== 1) {
      console.error(`State file at ${STATE_PATH} has unknown schema_version ${parsed.schema_version}; backing up + resetting.`);
      try {
        writeFileSync(STATE_PATH + ".bak", raw, "utf-8");
      } catch {
        // backup failure is non-fatal
      }
      return { schema_version: 1, last_writer: "gstack-memory-ingest", sessions: {} };
    }
    return parsed;
  } catch (err) {
    console.error(`State file at ${STATE_PATH} corrupt; backing up + resetting.`);
    try {
      const raw = readFileSync(STATE_PATH, "utf-8");
      writeFileSync(STATE_PATH + ".bak", raw, "utf-8");
    } catch {
      // best-effort
    }
    return { schema_version: 1, last_writer: "gstack-memory-ingest", sessions: {} };
  }
}

function saveState(state: IngestState): void {
  // F6 (Codex finding 6): tmp+rename atomic write so a crash mid-write
  // never leaves a truncated/corrupt state file. Matches the pattern
  // in gstack-gbrain-sync.ts:saveSyncState.
  try {
    mkdirSync(dirname(STATE_PATH), { recursive: true });
    const tmp = `${STATE_PATH}.tmp.${process.pid}`;
    writeFileSync(tmp, JSON.stringify(state, null, 2), "utf-8");
    renameSync(tmp, STATE_PATH);
  } catch (err) {
    console.error(`[state] write failed: ${(err as Error).message}`);
  }
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

function fileChangedSinceState(path: string, state: IngestState): boolean {
  const entry = state.sessions[path];
  if (!entry) return true;
  try {
    const st = statSync(path);
    const mtimeNs = Math.floor(st.mtimeMs * 1e6);
    if (mtimeNs === entry.mtime_ns) return false;
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
}

function makeWalkContext(args: CliArgs, state: IngestState): WalkContext {
  const ninetyDaysAgoMs = Date.now() - 90 * 24 * 60 * 60 * 1000;
  return {
    args,
    state,
    windowStartMs: args.allHistory ? 0 : ninetyDaysAgoMs,
  };
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

export function parseTranscriptJsonl(path: string): ParsedSession | null {
  // Best-effort tolerant parser. Handles truncated last lines (D10 partial-flag).
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
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

function dateOnly(ts: string | undefined): string {
  if (!ts) return new Date().toISOString().slice(0, 10);
  try {
    return new Date(ts).toISOString().slice(0, 10);
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

function buildTranscriptPage(path: string, session: ParsedSession): PageRecord {
  const remote = resolveGitRemote(session.cwd);
  const slug_repo = repoSlug(remote);
  const date = dateOnly(session.start_time);
  const sessionPrefix = session.session_id.slice(0, 12);
  const slug = `transcripts/${session.agent}/${slug_repo}/${date}-${sessionPrefix}`;
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

  const frontmatter = [
    "---",
    `agent: ${session.agent}`,
    `session_id: ${session.session_id}`,
    `cwd: ${session.cwd || ""}`,
    `git_remote: ${remote || "_unattributed"}`,
    `start_time: ${session.start_time || ""}`,
    `end_time: ${session.end_time || ""}`,
    `message_count: ${session.message_count}`,
    `tool_calls: ${session.tool_calls}`,
    `source_path: ${path}`,
    session.partial ? "partial: true" : "",
    "---",
    "",
  ].filter((l) => l !== "").join("\n");

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
    git_remote: remote,
    start_time: session.start_time,
    end_time: session.end_time,
    partial: session.partial,
    size_bytes: stats.size,
    content_sha256: sha,
  };
}

function buildArtifactPage(path: string, type: MemoryType): PageRecord {
  const stats = statSync(path);
  const sha = fileSha256(path);
  const raw = readFileSync(path, "utf-8");

  // Extract repo slug from path: ~/.gstack/projects/<slug>/...
  let slug_repo = "_unattributed";
  const m = path.match(/\/\.gstack\/projects\/([^/]+)\//);
  if (m) slug_repo = m[1];

  const date = new Date(stats.mtimeMs).toISOString().slice(0, 10);
  const baseName = basename(path, path.endsWith(".jsonl") ? ".jsonl" : ".md");

  const slug = `${type}s/${slug_repo}/${date}-${baseName}`;
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
// Architecture (post plan-eng-review + Codex outside-voice):
//
//   walkAllSources(ctx)
//     → for each path: mtime-skip / source-file gitleaks (D3) / parse / buildPage
//     → renderPageBody injects title/type/tags into YAML frontmatter
//     → writeStaged: mkdir -p slug subdirs (D1), write ${slug}.md
//   → snapshot ~/.gbrain/sync-failures.jsonl byte-offset           (D7)
//   → spawnSync `gbrain import <stagingDir> --no-embed --json`     (D6)
//   → parseImportJson(stdout) → { imported, skipped, errors, ... } (D6 OK/ERR)
//   → readNewFailures(preImportOffset, slugMap) → Set<sourcePath>  (D7)
//   → state.sessions[path] = { ... } for prepared files NOT in failed set
//   → saveStateAtomic (F6 tmp+rename) + cleanupStagingDir
//
// We trust gbrain's content_hash idempotency (verified in
// ~/git/gbrain/src/core/import-file.ts:242-243, :478) — repeated imports
// of identical content are cheap. So we do NOT track per-file skip_reasons,
// do NOT keep a SIGTERM checkpoint, and do NOT advance a three-state verdict.

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
function renderPageBody(page: PageRecord): string {
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

interface PreparedPage {
  /** Page slug (path-shaped, e.g. "transcripts/claude-code/foo"). */
  slug: string;
  /** Original source file on disk (e.g. ~/.claude/projects/.../foo.jsonl). */
  source_path: string;
  /** Full markdown including frontmatter — ready to write. */
  rendered_body: string;
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

function writeStaged(prepared: PreparedPage[], stagingDir: string): StagingResult {
  mkdirSync(stagingDir, { recursive: true });
  const stagedPathToSource = new Map<string, string>();
  const errors: Array<{ slug: string; error: string }> = [];
  let written = 0;
  for (const p of prepared) {
    const relPath = stagedRelPath(p.slug);
    const absPath = join(stagingDir, relPath);
    try {
      mkdirSync(dirname(absPath), { recursive: true });
      writeFileSync(absPath, p.rendered_body, "utf-8");
      stagedPathToSource.set(relPath, p.source_path);
      written++;
    } catch (err) {
      errors.push({ slug: p.slug, error: (err as Error).message });
    }
  }
  return { staging_dir: stagingDir, written, errors, stagedPathToSource };
}

interface ImportJsonResult {
  status?: string;
  duration_s?: number;
  imported?: number;
  skipped?: number;
  errors?: number;
  chunks?: number;
  total_files?: number;
}

/**
 * Parse the `gbrain import --json` stdout payload (single JSON object on
 * the last non-empty line per commands/import.ts:271-275).
 *
 * Returns parsed counts on success, or `null` to signal "unparseable" — the
 * caller treats null as ERR (system_error) rather than silently passing
 * through as zeros. Pre-2026-05-11 this returned zeros on parse failure,
 * which silently masked gbrain crashes as "0 imported, 0 failed = OK".
 */
function parseImportJson(stdout: string): ImportJsonResult | null {
  const lines = stdout.split("\n").map((s) => s.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line.startsWith("{") && line.endsWith("}")) {
      try {
        const parsed = JSON.parse(line);
        if (typeof parsed === "object" && parsed && "imported" in parsed) {
          return parsed as ImportJsonResult;
        }
      } catch {
        // try next line up
      }
    }
  }
  return null;
}

/**
 * Read failures appended to ~/.gbrain/sync-failures.jsonl since the
 * snapshotted byte offset, and map them back to source paths.
 *
 * D7: gbrain import writes per-file failures to sync-failures.jsonl
 * (commands/import.ts:308-310) explicitly so "callers can gate state
 * advances" (comment at :28). We snapshot the file size before import
 * and read only the appended bytes after, so we never confuse new
 * entries with prior-run leftovers.
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
    // Best-effort. If we can't read failures, we conservatively assume
    // none — caller will state-record all prepared files. Worst case:
    // failed files get a retry-on-next-run shot anyway via content_hash.
  }
  return failed;
}

// ── Main ingest passes ─────────────────────────────────────────────────────

/**
 * The ONE attribution gate (#2394): a transcript is attributable iff its cwd
 * resolves to a git remote. Both probeMode (via transcriptCwdFromPrefix +
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
 * Non-transcript types (artifacts) always pass — the attribution filter in
 * preparePages only applies to transcripts (#2394).
 */
function transcriptCwdFromPrefix(path: string): string {
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
    return "";
  }
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length === 0) return "";

  let cwd = "";
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
        // Codex: cwd comes from the session_meta FIRST record only.
        cwd = rec.payload?.cwd || rec.cwd || "";
        break;
      }
    }
    // Claude Code: first record with a cwd wins (the first record included).
    if (rec?.cwd) {
      cwd = rec.cwd;
      break;
    }
  }
  return cwd;
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
      const cwd = transcriptCwdFromPrefix(path);
      remote = cwd ? resolveGitRemote(cwd) : "";
      if (!args.includeUnattributed && remote === "") {
        skippedUnattributed++;
        continue;
      }
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
    else if (fileChangedSinceState(path, state)) updatedCount++;
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
    estimate_minutes: estimateMinutes,
  };
}

/**
 * Prepare phase: walk sources, apply incremental + optional-secret-scan filters,
 * parse transcripts/artifacts into PageRecord, render bodies with
 * frontmatter. Returns the PreparedPage[] to stage + counts of files
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
): {
  prepared: PreparedPage[];
  skippedSecret: number;
  skippedDedup: number;
  skippedUnattributed: number;
  skippedPolicyReadonly: number;
  skippedPolicyDeny: number;
  parseFailed: number;
  partialPages: number;
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

    if (args.mode === "incremental" && !fileChangedSinceState(path, state)) {
      skippedDedup++;
      continue;
    }

    // Optional belt-and-suspenders: when --scan-secrets is set, scan the
    // source file with gitleaks and skip dirty ones. Off by default
    // because gstack-brain-sync already gates the cross-machine boundary
    // and per-file gitleaks costs ~256ms/file (4-8 min on a real corpus).
    if (args.scanSecrets) {
      const scan = secretScanFile(path);
      if (scan.scanner === "gitleaks" && scan.findings.length > 0) {
        skippedSecret++;
        if (!args.quiet) {
          console.error(
            `[secret-scan match] ${path} (${scan.findings.length} finding${
              scan.findings.length === 1 ? "" : "s"
            }); skipped`,
          );
        }
        continue;
      }
    }

    let page: PageRecord;
    try {
      if (type === "transcript") {
        const session = parseTranscriptJsonl(path);
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
      } else {
        page = buildArtifactPage(path, type);
      }
    } catch (err) {
      parseFailed++;
      console.error(`[parse-error] ${path}: ${(err as Error).message}`);
      continue;
    }

    prepared.push({
      slug: page.slug,
      source_path: path,
      rendered_body: renderPageBody(page),
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
    policyError,
  };
}

/**
 * Make a per-run staging directory at ~/.gstack/.staging-ingest-<pid>-<ts>/
 * The pid+ts namespace avoids collisions when two ingest passes run
 * concurrently (the orchestrator's lock should prevent this, but
 * defense-in-depth).
 */
function makeStagingDir(): string {
  const dir = join(GSTACK_HOME, `.staging-ingest-${process.pid}-${Date.now()}`);
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
): Promise<{ status: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  const first = await runGbrainImportOnce(stagingDir, timeoutMs, true);
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
    return runGbrainImportOnce(stagingDir, timeoutMs, false);
  }
  return first;
}

function runGbrainImportOnce(
  stagingDir: string,
  timeoutMs: number,
  includeGitignored: boolean,
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

async function ingestPass(args: CliArgs): Promise<BulkResult> {
  const t0 = Date.now();
  const state = loadState();
  const ctx = makeWalkContext(args, state);

  // Phase 1: prepare (parse + secret-scan + filter + render frontmatter).
  const prep = preparePages(args, ctx, state);

  let written = 0;
  let failed = 0;

  // #2392 HARD ERROR: the policy store exists but could not be consulted.
  // Abort before ANY write — state recording, staging, gbrain import — so a
  // corrupt store can never silently bypass a set deny/read-only policy.
  if (prep.policyError) {
    console.error(`[memory-ingest] ERR: ${prep.policyError}`);
    return {
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
    // --no-write: skip the gbrain import call but still record state for
    // prepared pages (treat them as ingested for dedup purposes). Matches
    // the prior contract from --help: "Skip gbrain put calls (still
    // updates state file)".
    const nowIso = new Date().toISOString();
    for (const p of prep.prepared) {
      try {
        state.sessions[p.source_path] = {
          mtime_ns: Math.floor(statSync(p.source_path).mtimeMs * 1e6),
          sha256: fileSha256(p.source_path),
          ingested_at: nowIso,
          page_slug: p.page_slug,
          partial: p.partial,
        };
        written++;
      } catch {
        // best-effort state record
      }
    }
    state.last_full_walk = new Date().toISOString();
    state.last_writer = "gstack-memory-ingest";
    saveState(state);
    return {
      written,
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
    // Nothing to import — still touch state.last_full_walk and exit.
    state.last_full_walk = new Date().toISOString();
    state.last_writer = "gstack-memory-ingest";
    saveState(state);
    return {
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

  // Phase 2: stage + (optionally) invoke gbrain import.
  //
  // Split-engine branch per plan D11: in remote-http MCP mode, we stage to a
  // PERSISTENT dir under ~/.gstack/transcripts/ and SKIP `gbrain import`
  // entirely. gstack-brain-sync push will pick the dir up via its allowlist
  // and the brain admin's pull job will index transcripts into the remote
  // brain. Local PGLite (if any) stays code-only.
  //
  // Resume branch for #1611: when the orchestrator sets
  // GSTACK_INGEST_RESUME_DIR (because gbrain's import-checkpoint.json points
  // at an existing dir from a prior SIGTERM'd run), reuse that staging dir
  // and skip the prepare/writeStaged phase entirely. gbrain's checkpoint
  // tells it where to resume.
  const remoteHttpMode = isRemoteHttpMcpMode();
  const resumeDir = process.env.GSTACK_INGEST_RESUME_DIR;
  // #1802 second entry point: this binary is runnable directly, so it must not
  // trust GSTACK_INGEST_RESUME_DIR just because it exists — a stale/poisoned env
  // could make us `gbrain import` (and later clean up) an arbitrary directory.
  // Prove ownership here too, independently of the orchestrator's decideResume.
  const resuming = !remoteHttpMode
    && typeof resumeDir === "string"
    && resumeDir.length > 0
    && existsSync(resumeDir)
    && checkOwnedStagingDir(resumeDir, GSTACK_HOME).ok;
  if (!remoteHttpMode && resumeDir && resumeDir.length > 0 && !resuming) {
    console.error(
      `[memory-ingest] ignoring GSTACK_INGEST_RESUME_DIR="${resumeDir}" — not a proven staging dir (#1802); staging fresh.`,
    );
  }
  const stagingDir = resuming
    ? resumeDir!
    : remoteHttpMode
      ? makePersistentTranscriptDir()
      : makeStagingDir();
  // Register staging dir with the signal forwarder so SIGTERM/SIGINT can
  // either preserve (when gbrain checkpointed it) or synchronously clean up.
  // The async finally block below does NOT run after a signal-handler exit.
  // In remote-http mode we skip registration — the dir is meant to persist.
  if (!remoteHttpMode) {
    _activeStagingDir = stagingDir;
  }
  // #1802 C3: set when the import-timeout branch leaves a resumable checkpoint
  // pointing at this staging dir, so the finally preserves it for the next run
  // instead of deleting it (the SIGTERM forwarder's preserve branch only runs
  // when the PARENT is signalled, which an internal timeout never does).
  let preserveStaging = false;
  try {
    let staging: StagingResult;
    if (resuming) {
      // Pages are already on disk from the previous run. Skip writeStaged.
      // The "written" count for the verdict reflects what's on disk now;
      // gbrain's import will skip already-completed entries via its own
      // checkpoint (processedIndex+1).
      if (!args.quiet) {
        console.error(
          `[memory-ingest] resuming previous staging dir ${stagingDir} (skipping prepare phase)`,
        );
      }
      // #1802 C4: reconstruct stagedPathToSource from the prepared pages so
      // readNewFailures() can still map gbrain's per-file failures back to
      // sources on resume. An empty map made every failed file fall through to
      // state-recording — i.e. silently marked ingested despite failing.
      const stagedPathToSource = new Map<string, string>();
      for (const p of prep.prepared) {
        stagedPathToSource.set(stagedRelPath(p.slug), p.source_path);
      }
      staging = { staging_dir: stagingDir, written: prep.prepared.length, errors: [], stagedPathToSource };
    } else {
      staging = writeStaged(prep.prepared, stagingDir);
    }
    failed += staging.errors.length;
    if (!args.quiet && staging.errors.length > 0) {
      for (const e of staging.errors.slice(0, 5)) {
        console.error(`[stage-error] ${e.slug}: ${e.error}`);
      }
    }

    // D7: snapshot sync-failures.jsonl byte-offset before import so we
    // can read only newly-appended failure entries afterwards.
    const syncFailuresPath = join(homedir(), ".gbrain", "sync-failures.jsonl");
    let preImportOffset = 0;
    try {
      if (existsSync(syncFailuresPath)) {
        preImportOffset = statSync(syncFailuresPath).size;
      }
    } catch {
      // best-effort; absent file → 0 offset, all future entries are "new"
    }

    if (!args.quiet) {
      const action = remoteHttpMode
        ? "persisting to artifacts pipeline (skipping local gbrain import — remote-http mode)"
        : "running gbrain import";
      console.error(
        `[memory-ingest] staged ${staging.written} pages → ${stagingDir}; ${action}...`,
      );
    }

    // Remote-http branch (split-engine D11): no local gbrain import. The
    // staged markdown lives under ~/.gstack/transcripts/<run-id>/ and the
    // next gstack-brain-sync push will move it to the artifacts repo. From
    // there the brain admin's pull job indexes into the remote brain.
    //
    // We treat ALL prepared pages as "written" since the import didn't run
    // and we have no per-page failures from gbrain to filter on. The
    // brain admin's pull pipeline is the authoritative gate; from this
    // machine's perspective, the act of staging IS the write.
    if (remoteHttpMode) {
      const nowIso = new Date().toISOString();
      for (const p of prep.prepared) {
        try {
          state.sessions[p.source_path] = {
            mtime_ns: Math.floor(statSync(p.source_path).mtimeMs * 1e6),
            sha256: fileSha256(p.source_path),
            ingested_at: nowIso,
            page_slug: p.page_slug,
            partial: p.partial,
          };
          written++;
        } catch (err) {
          console.error(
            `[state-record] ${p.source_path}: ${(err as Error).message}`,
          );
        }
      }
      state.last_full_walk = nowIso;
      state.last_writer = "gstack-memory-ingest (remote-http mode)";
      saveState(state);
      if (!args.quiet) {
        console.error(
          `[memory-ingest] persisted ${written} pages to ${stagingDir} (brain admin will index on next pull)`,
        );
      }
      // Skip the gbrain-import error handling + cleanupStagingDir paths
      // below by short-circuiting the function.
      return {
        written,
        skipped_secret: prep.skippedSecret,
        skipped_dedup: prep.skippedDedup,
        skipped_unattributed: prep.skippedUnattributed,
        skipped_policy_readonly: prep.skippedPolicyReadonly,
        skipped_policy_deny: prep.skippedPolicyDeny,
        failed,
        duration_ms: Date.now() - t0,
        partial_pages: prep.partialPages,
      };
    }

    // D6: single batch import. `--no-embed` matches the prior per-file
    // behavior (we never enabled embedding); embeddings happen on-demand
    // via gbrain's own pipelines. `--json` gives us structured counts.
    //
    // Async spawn (not spawnSync) so the signal forwarder installed in
    // runGbrainImport propagates SIGTERM/SIGINT to the child. With sync
    // spawn, parent termination orphans the gbrain process (observed
    // during 2026-05-10 cold-run testing — gbrain kept running 15 min
    // after the orchestrator timed out).
    //
    // Egress receipt BEFORE the import (fail-closed): the gbrain DB may be a
    // remote Postgres, so the ingest is a potential off-machine send. The
    // gbrain subprocess owns the wire bytes (content-free receipt, sha256
    // null). The remote-http branch above stages locally only — its egress
    // happens in gstack-brain-sync, which writes its own receipt at the push.
    try {
      writeReceipt({
        sink: "memory-ingest",
        host: "gbrain-db (user-configured DATABASE_URL)",
        payloadClass: `transcript-pages count=${staging.written} (sent by gbrain subprocess)`,
        bytes: 0,
        sha256: null,
        consent: "gbrain setup consent (/setup-gbrain)",
      });
    } catch (err) {
      const msg = `EGRESS_RECEIPT_FAILED: ${(err as Error).message} — ingest refused`;
      console.error(`[memory-ingest] ERR: ${msg}`);
      failed += prep.prepared.length;
      return {
        written: 0,
        skipped_secret: prep.skippedSecret,
        skipped_dedup: prep.skippedDedup,
        skipped_unattributed: prep.skippedUnattributed,
        skipped_policy_readonly: prep.skippedPolicyReadonly,
        skipped_policy_deny: prep.skippedPolicyDeny,
        failed,
        duration_ms: Date.now() - t0,
        partial_pages: prep.partialPages,
        system_error: msg,
      };
    }
    const importResult = await runGbrainImport(stagingDir, resolveImportTimeoutMs());

    const stdout = importResult.stdout || "";
    const stderr = importResult.stderr || "";
    const importJson = parseImportJson(stdout);

    if (importResult.status !== 0) {
      // #1611/#1802 C3: on timeout, gbrain may have written
      // import-checkpoint.json so the next /sync-gbrain can resume. But an
      // INTERNAL timeout (runGbrainImport kills the child and returns here)
      // never signals the parent, so the SIGTERM forwarder's preserve branch
      // doesn't run — and the finally would otherwise delete the staging dir
      // despite a "checkpoint preserved" message. Mirror the forwarder: preserve
      // only when gbrain actually checkpointed against this dir; otherwise let
      // the finally clean up (nothing to resume) and say so honestly.
      if (importResult.timedOut) {
        const mins = Math.round(resolveImportTimeoutMs() / 60000);
        const checkpointed = stagingDirIsCheckpointed(stagingDir);
        const msg = checkpointed
          ? `gbrain import timed out after ${mins}min; checkpoint preserved — re-run ` +
            `/sync-gbrain to resume (raise GSTACK_INGEST_TIMEOUT_MS for big brains)`
          : `gbrain import timed out after ${mins}min before writing a checkpoint; ` +
            `re-run /sync-gbrain to restage (raise GSTACK_INGEST_TIMEOUT_MS for big brains)`;
        if (checkpointed) preserveStaging = true;
        console.error(`[memory-ingest] ${msg}`);
        return {
          written: 0,
          skipped_secret: prep.skippedSecret,
          skipped_dedup: prep.skippedDedup,
          skipped_unattributed: prep.skippedUnattributed,
          skipped_policy_readonly: prep.skippedPolicyReadonly,
          skipped_policy_deny: prep.skippedPolicyDeny,
          failed,
          duration_ms: Date.now() - t0,
          partial_pages: prep.partialPages,
          system_error: msg,
        };
      }
      const tail = (stderr.trim().split("\n").pop() || "").slice(0, 300);
      const msg = `gbrain import exited ${importResult.status}: ${tail}`;
      console.error(`[memory-ingest] ERR: ${msg}`);
      // We conservatively state-record nothing on a non-zero exit — per-run
      // partial progress is invisible to us when the importer crashed.
      // sync-failures.jsonl entries may still hold per-file detail.
      failed += prep.prepared.length;
      return {
        written: 0,
        skipped_secret: prep.skippedSecret,
        skipped_dedup: prep.skippedDedup,
        skipped_unattributed: prep.skippedUnattributed,
        skipped_policy_readonly: prep.skippedPolicyReadonly,
        skipped_policy_deny: prep.skippedPolicyDeny,
        failed,
        duration_ms: Date.now() - t0,
        partial_pages: prep.partialPages,
        system_error: msg,
      };
    }

    if (!args.quiet) {
      // Echo gbrain's own progress lines on stderr through so the user sees
      // them when running interactively. Already on our stderr from the
      // child via `stdio: pipe`, but we explicitly forward for clarity.
      process.stderr.write(stderr);
    }

    if (importJson === null) {
      // gbrain exited 0 but didn't emit a parseable --json line. Treat as
      // ERR rather than silently passing zeros through — silent zeros let
      // a future gbrain-output regression mask data loss.
      const msg =
        "gbrain import exited 0 but emitted no parseable --json payload. " +
        "Refusing to advance state.";
      console.error(`[memory-ingest] ERR: ${msg}`);
      failed += prep.prepared.length;
      return {
        written: 0,
        skipped_secret: prep.skippedSecret,
        skipped_dedup: prep.skippedDedup,
        skipped_unattributed: prep.skippedUnattributed,
        skipped_policy_readonly: prep.skippedPolicyReadonly,
        skipped_policy_deny: prep.skippedPolicyDeny,
        failed,
        duration_ms: Date.now() - t0,
        partial_pages: prep.partialPages,
        system_error: msg,
      };
    }

    // D7: identify which staged files failed to import and exclude them
    // from state recording. Source paths get a retry on the next run.
    const failedSources = readNewFailures(
      syncFailuresPath,
      preImportOffset,
      staging.stagedPathToSource,
    );
    failed += failedSources.size;

    // Reconcile gbrain's own accounting against what we staged. Without this,
    // a batch that gbrain never SAW is indistinguishable from a batch that
    // succeeded: readNewFailures() only reports PER-FILE failures, so when
    // `gbrain import` collects zero files it writes nothing to
    // sync-failures.jsonl, failedSources is empty, and every prepared file
    // gets state-recorded as ingested. The pass then reports "N written"
    // while the brain gained nothing — and because state now says "done",
    // no future run retries. Silent, permanent data loss.
    //
    // Observed cause: `gbrain import` honours .gitignore, and
    // `gstack-artifacts-init` writes `.gitignore = "*"` into $GSTACK_HOME.
    // makeStagingDir() stages under $GSTACK_HOME, so on any machine that has
    // run artifacts-init, collect_files returns 0 for every batch.
    //
    // `skipped` counts content_hash no-ops, which ARE successful landings.
    const expectedLandings = prep.prepared.length - failedSources.size;
    const accountedLandings =
      (importJson.imported ?? 0) + (importJson.skipped ?? 0);
    if (accountedLandings < expectedLandings) {
      const collected =
        importJson.total_files !== undefined
          ? ` gbrain collected ${importJson.total_files} file(s) from the staging dir.`
          : "";
      const msg =
        `gbrain import accounted for ${accountedLandings} of ${expectedLandings} staged page(s) ` +
        `(imported=${importJson.imported ?? 0}, unchanged=${importJson.skipped ?? 0}).${collected} ` +
        `Refusing to advance state — the unaccounted pages would be marked ingested without ` +
        `landing in the brain. If the count is 0, check whether ${stagingDir} is inside a git ` +
        `repo that ignores it (gbrain import honours .gitignore).`;
      console.error(`[memory-ingest] ERR: ${msg}`);
      failed += prep.prepared.length;
      return {
        written: 0,
        skipped_secret: prep.skippedSecret,
        skipped_dedup: prep.skippedDedup,
        skipped_unattributed: prep.skippedUnattributed,
        skipped_policy_readonly: prep.skippedPolicyReadonly,
        skipped_policy_deny: prep.skippedPolicyDeny,
        failed,
        duration_ms: Date.now() - t0,
        partial_pages: prep.partialPages,
        system_error: msg,
      };
    }

    // Phase 3: state recording. Only files that landed in gbrain get
    // their mtime+sha256 stamped. Failed source paths are deliberately
    // left un-state'd so the next run re-prepares them and gbrain's
    // content_hash dedup short-circuits the import.
    const nowIso = new Date().toISOString();
    for (const p of prep.prepared) {
      if (failedSources.has(p.source_path)) continue;
      try {
        state.sessions[p.source_path] = {
          mtime_ns: Math.floor(statSync(p.source_path).mtimeMs * 1e6),
          sha256: fileSha256(p.source_path),
          ingested_at: nowIso,
          page_slug: p.page_slug,
          partial: p.partial,
        };
        written++;
        if (!args.quiet) {
          const tag = p.partial ? " [partial]" : "";
          console.log(`[${written}] ${p.page_slug}${tag}`);
        }
      } catch (err) {
        // statSync can fail if the source file was removed mid-run; skip
        // recording but don't fail the whole pass.
        console.error(
          `[state-record] ${p.source_path}: ${(err as Error).message}`,
        );
      }
    }

    if (!args.quiet) {
      console.error(
        `[memory-ingest] gbrain import: ${importJson.imported ?? 0} imported, ` +
          `${importJson.skipped ?? 0} unchanged, ${importJson.errors ?? 0} failed` +
          (failedSources.size > 0
            ? ` (see ~/.gbrain/sync-failures.jsonl for details)`
            : ""),
      );
    }
    // Silent-zero pathology detector (#2144's other half): pages were staged
    // but NOTHING imported or skipped-as-unchanged. That shape hid the dead
    // ingest for months — it must be loud even under --quiet, because a run
    // that indexes nothing is otherwise indistinguishable from a healthy one.
    const importedCount = (importJson.imported ?? 0) + (importJson.skipped ?? 0);
    if (prep.prepared.length > 0 && importedCount === 0 && (importJson.errors ?? 0) === 0) {
      console.error(
        `[memory-ingest] WARNING: ${prep.prepared.length} page(s) staged but gbrain collected ZERO ` +
          `(no imports, no unchanged-skips, no errors). This is the #2144 silent-zero shape — ` +
          `check gbrain's import.collect_files log line and your gbrain version.`,
      );
    }
  } finally {
    // #1802 D1: in remote-http mode `stagingDir` is the PERSISTENT transcript
    // dir (makePersistentTranscriptDir, under ~/.gstack/transcripts/) that
    // gstack-brain-sync push must pick up — it is NOT a `.staging-ingest-*` dir
    // and must never be deleted here. The remote-http branch above already
    // documents this intent ("Skip the ... cleanupStagingDir paths"), but a
    // `finally` runs on its `return`, so the gate has to live here. Gating on
    // mode (rather than widening the ownership guard) keeps checkOwnedStagingDir
    // strict: it only ever sees `.staging-ingest-*` dirs.
    if (!remoteHttpMode && !preserveStaging) cleanupStagingDir(stagingDir);
    _activeStagingDir = null;
  }

  state.last_full_walk = new Date().toISOString();
  state.last_writer = "gstack-memory-ingest";
  saveState(state);

  return {
    written,
    skipped_secret: prep.skippedSecret,
    skipped_dedup: prep.skippedDedup,
    skipped_unattributed: prep.skippedUnattributed,
    skipped_policy_readonly: prep.skippedPolicyReadonly,
    skipped_policy_deny: prep.skippedPolicyDeny,
    failed: failed + prep.parseFailed,
    duration_ms: Date.now() - t0,
    partial_pages: prep.partialPages,
  };
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
  console.log("By type:");
  for (const [t, v] of Object.entries(r.by_type)) {
    if (v.count > 0) {
      console.log(`  ${t.padEnd(24)} ${String(v.count).padStart(6)} files  ${formatBytes(v.bytes).padStart(8)}`);
    }
  }
  console.log(`\nEstimate: ~${r.estimate_minutes} min for full --bulk pass.`);
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
  console.log(`  failed:                ${r.failed}`);
  console.log(`  duration:              ${(r.duration_ms / 1000).toFixed(1)}s`);
  if (args.benchmark) {
    const pps = r.duration_ms > 0 ? (r.written * 1000) / r.duration_ms : 0;
    console.log(`  throughput:            ${pps.toFixed(2)} pages/sec`);
  }
}

// ── Entry point ────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs();

  // Engine tier detection — informational; routing happens in gbrain server-side.
  const engine = detectEngineTier();
  if (!args.quiet) {
    console.error(`[engine] ${engine.engine}${engine.engine === "supabase" ? ` (${engine.supabase_url || "configured"})` : ""}`);
  }

  if (args.mode === "probe") {
    const report = await probeMode(args);
    printProbeReport(report, false);
    return;
  }

  if (args.mode === "incremental" && args.quiet) {
    // Steady-state fast path: log nothing unless changes happen.
    const t0 = Date.now();
    const result = await ingestPass(args);
    const dt = Date.now() - t0;
    if (result.written > 0 || result.failed > 0) {
      console.error(`[memory-ingest] ${result.written} written, ${result.failed} failed in ${dt}ms`);
    }
    // D6: system_error → process-level failure; orchestrator sees ERR.
    // Per-file errors do NOT exit non-zero.
    if (result.system_error) process.exit(1);
    return;
  }

  const result = await ingestPass(args);
  printBulkResult(result, args);
  if (result.system_error) process.exit(1);
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
