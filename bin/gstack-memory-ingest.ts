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
} from "fs";
import { join, basename, dirname } from "path";
import { execSync, execFileSync, spawnSync, spawn, type ChildProcess } from "child_process";
import { homedir } from "os";
import { createHash } from "crypto";

import {
  canonicalizeRemote,
  secretScanFile,
  detectEngineTier,
  withErrorContext,
} from "../lib/gstack-memory-helpers";

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
  estimate_minutes: number;
}

interface BulkResult {
  written: number;
  skipped_secret: number;
  skipped_dedup: number;
  skipped_unattributed: number;
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
  --no-write           Skip gbrain put_page calls (still updates state file).
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

function parseTranscriptJsonl(path: string): ParsedSession | null {
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
      // Codex shape: each record has payload.message
      const msg = rec.payload.message;
      const role = msg.role || "user";
      const content = extractContentText(msg);
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

function resolveGitRemote(cwd: string): string {
  if (!cwd) return "";
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
    execSync("command -v gbrain", { stdio: "ignore" });
    // Probe `--help` for the `import` subcommand. gbrain v0.20.0+ ships
    // `import <dir>` (batch markdown import via path-authoritative slugs).
    // If absent, we surface a single clean error here rather than failing
    // the whole stage with a confusing usage message from gbrain itself.
    const help = execFileSync("gbrain", ["--help"], {
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "pipe"],
    });
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
function writeStaged(prepared: PreparedPage[], stagingDir: string): StagingResult {
  mkdirSync(stagingDir, { recursive: true });
  const stagedPathToSource = new Map<string, string>();
  const errors: Array<{ slug: string; error: string }> = [];
  let written = 0;
  for (const p of prepared) {
    const relPath = `${p.slug}.md`;
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
function readNewFailures(
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

  for (const { path, type } of walkAllSources(ctx)) {
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
  // (gitleaks + render + put_page + embedding). Scale linearly.
  const estimateMinutes = Math.max(1, Math.round((newCount + updatedCount) * 0.15 / 60));

  return {
    total_files: totalFiles,
    total_bytes: totalBytes,
    by_type: byType,
    new_count: newCount,
    updated_count: updatedCount,
    unchanged_count: unchangedCount,
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
  parseFailed: number;
  partialPages: number;
} {
  const prepared: PreparedPage[] = [];
  let skippedSecret = 0;
  let skippedDedup = 0;
  let skippedUnattributed = 0;
  let parseFailed = 0;
  let partialPages = 0;

  for (const { path, type } of walkAllSources(ctx)) {
    if (args.limit !== null && prepared.length >= args.limit) break;

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
        if (!args.includeUnattributed && !session.cwd) {
          skippedUnattributed++;
          continue;
        }
        page = buildTranscriptPage(path, session);
        if (!args.includeUnattributed && page.git_remote === "_unattributed") {
          skippedUnattributed++;
          continue;
        }
        if (page.partial) partialPages++;
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
    });
  }

  return {
    prepared,
    skippedSecret,
    skippedDedup,
    skippedUnattributed,
    parseFailed,
    partialPages,
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
  return dir;
}

/**
 * Best-effort recursive cleanup. Failures swallowed — at worst we leak a
 * staging dir to disk; the next run uses a new one and they age out via
 * normal disk hygiene. We deliberately do NOT crash the pipeline on
 * cleanup failure.
 */
function cleanupStagingDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
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
 *   2. synchronously clean up the staging dir BEFORE process.exit (otherwise
 *      finally blocks in async callers don't run after process.exit from
 *      inside a signal handler, leaking the staging dir on every interrupt)
 */
let _activeImportChild: ChildProcess | null = null;
let _activeStagingDir: string | null = null;
let _signalHandlersInstalled = false;
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
    // Synchronously clean up the active staging dir before exiting. The async
    // `finally` blocks in ingestPass never run after process.exit fires from
    // inside this handler, so cleanup has to happen here.
    if (_activeStagingDir) {
      cleanupStagingDir(_activeStagingDir);
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
function runGbrainImport(
  stagingDir: string,
  timeoutMs: number,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  installSignalForwarder();
  return new Promise((resolve) => {
    const child = spawn(
      "gbrain",
      ["import", stagingDir, "--no-embed", "--json"],
      { stdio: ["ignore", "pipe", "pipe"] },
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
      });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      _activeImportChild = null;
      resolve({
        status: null,
        stdout,
        stderr: stderr + `\n[spawn-error] ${(err as Error).message}`,
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

  if (args.noWrite) {
    // --no-write: skip the gbrain import call but still record state for
    // prepared pages (treat them as ingested for dedup purposes). Matches
    // the prior contract from --help: "Skip gbrain put_page calls (still
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
      failed: prep.parseFailed + prep.prepared.length,
      duration_ms: Date.now() - t0,
      partial_pages: prep.partialPages,
      system_error: msg,
    };
  }

  // Phase 2: stage to a per-run dir + invoke gbrain import.
  const stagingDir = makeStagingDir();
  // Register staging dir with the signal forwarder so SIGTERM/SIGINT can
  // synchronously clean it up before process.exit (the async finally block
  // below does NOT run after a signal-handler exit).
  _activeStagingDir = stagingDir;
  try {
    const staging = writeStaged(prep.prepared, stagingDir);
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
      console.error(
        `[memory-ingest] staged ${staging.written} pages → ${stagingDir}; running gbrain import...`,
      );
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
    const importResult = await runGbrainImport(stagingDir, 30 * 60 * 1000);

    const stdout = importResult.stdout || "";
    const stderr = importResult.stderr || "";
    const importJson = parseImportJson(stdout);

    if (importResult.status !== 0) {
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
  } finally {
    cleanupStagingDir(stagingDir);
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

main().catch((err) => {
  console.error(`gstack-memory-ingest fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
