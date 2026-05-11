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
} from "fs";
import { join, basename, dirname } from "path";
import { execSync, execFileSync } from "child_process";
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

  return { mode, quiet, benchmark, includeUnattributed, allHistory, sources, limit, noWrite };
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
  try {
    mkdirSync(dirname(STATE_PATH), { recursive: true });
    writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), "utf-8");
  } catch (err) {
    console.error(`[state] write failed: ${(err as Error).message}`);
  }
}

// ── File hash + change detection ───────────────────────────────────────────

function fileSha256(path: string, maxBytes = 1024 * 1024): string {
  // Hash the first 1MB only; sufficient for change detection on big JSONL.
  try {
    const fd = readFileSync(path);
    const slice = fd.length > maxBytes ? fd.subarray(0, maxBytes) : fd;
    return createHash("sha256").update(slice).digest("hex");
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

// ── Writer (calls `gbrain put`) ────────────────────────────────────────────

let _gbrainAvailability: boolean | null = null;
function gbrainAvailable(): boolean {
  if (_gbrainAvailability !== null) return _gbrainAvailability;
  try {
    execSync("command -v gbrain", { stdio: "ignore" });
    // gbrain v0.27 retired the legacy `put_page` flag-form for `put <slug>`
    // (content via stdin, metadata as YAML frontmatter). Probe `--help` for
    // the `put` subcommand so we surface a single clean error here rather
    // than failing every page with "Unknown command: put_page". The regex
    // anchors on the indented subcommand format gbrain's help actually uses
    // ("  put   ..."), not any whitespace-bordered "put" word in prose.
    const help = execFileSync("gbrain", ["--help"], {
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    _gbrainAvailability = /^\s+put\s/m.test(help);
  } catch {
    _gbrainAvailability = false;
  }
  return _gbrainAvailability;
}

function gbrainPutPage(page: PageRecord): { ok: boolean; error?: string } {
  if (!gbrainAvailable()) {
    return { ok: false, error: "gbrain CLI not in PATH or missing `put` subcommand" };
  }
  // gbrain v0.27+ uses `put <slug>` (positional, content via stdin) instead
  // of the legacy `put_page` flag form. Metadata rides as YAML frontmatter:
  //  - When the page body already starts with frontmatter (transcripts), inject
  //    title/type/tags into the existing block so gbrain's frontmatter parser
  //    picks them up.
  //  - When the page body has no frontmatter (raw artifacts: design-docs,
  //    learnings, builder-profile-entries), wrap with a fresh frontmatter
  //    carrying the same fields. Without this branch, artifact pages would
  //    land in gbrain with empty title/type/tags.
  let body = page.body;
  if (body.startsWith("---\n")) {
    // Locate the closing --- delimiter. buildTranscriptPage joins with "\n"
    // and does not append a trailing newline, so the close fence looks like
    // "...\n---" followed directly by body content (no "\n---\n" pattern).
    // Match the close on "\n---" only — the inject lands BEFORE the close
    // fence, inside the frontmatter block, regardless of what follows it.
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
  try {
    execFileSync("gbrain", ["put", page.slug], {
      input: body,
      encoding: "utf-8",
      // Bumped from 30s: auto-link reconciliation on dense transcripts hits
      // 30s once the brain has a few hundred existing pages.
      timeout: 60000,
      // Bumped from default 1MB: without this, gbrain's actual stderr gets
      // truncated and callers see only "Command failed:" with no detail.
      maxBuffer: 16 * 1024 * 1024,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { ok: true };
  } catch (err: any) {
    const stderr = err?.stderr?.toString?.() ?? "";
    const stdout = err?.stdout?.toString?.() ?? "";
    const detail = stderr || stdout || (err instanceof Error ? err.message : String(err));
    return { ok: false, error: detail.split("\n")[0].slice(0, 300) };
  }
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

async function ingestPass(args: CliArgs): Promise<BulkResult> {
  const t0 = Date.now();
  const state = loadState();
  const ctx = makeWalkContext(args, state);

  let written = 0;
  let skippedSecret = 0;
  let skippedDedup = 0;
  let skippedUnattributed = 0;
  let failed = 0;
  let partialPages = 0;

  for (const { path, type } of walkAllSources(ctx)) {
    if (args.limit !== null && written >= args.limit) break;

    if (args.mode === "incremental" && !fileChangedSinceState(path, state)) {
      skippedDedup++;
      continue;
    }

    // Secret scan first
    const scan = secretScanFile(path);
    if (scan.scanner === "gitleaks" && scan.findings.length > 0) {
      skippedSecret++;
      if (!args.quiet) {
        console.error(`[secret-scan match] ${path} (${scan.findings.length} finding${scan.findings.length === 1 ? "" : "s"}); skipped`);
      }
      continue;
    }

    let page: PageRecord;
    try {
      if (type === "transcript") {
        const session = parseTranscriptJsonl(path);
        if (!session) {
          failed++;
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
      failed++;
      console.error(`[parse-error] ${path}: ${(err as Error).message}`);
      continue;
    }

    const result = args.noWrite
      ? { ok: true }
      : await withErrorContext(
          `put_page:${page.slug}`,
          async () => gbrainPutPage(page),
          "gstack-memory-ingest"
        );
    if (!result.ok) {
      failed++;
      if (!args.quiet) {
        console.error(`[put-error] ${page.slug}: ${result.error || "unknown"}`);
      }
      continue;
    }

    state.sessions[path] = {
      mtime_ns: Math.floor(statSync(path).mtimeMs * 1e6),
      sha256: page.content_sha256,
      ingested_at: new Date().toISOString(),
      page_slug: page.slug,
      partial: page.partial,
    };
    written++;
    if (!args.quiet) {
      const tag = page.partial ? " [partial]" : "";
      console.log(`[${written}] ${page.slug}${tag}`);
    }
  }

  state.last_full_walk = new Date().toISOString();
  state.last_writer = "gstack-memory-ingest";
  saveState(state);

  return {
    written,
    skipped_secret: skippedSecret,
    skipped_dedup: skippedDedup,
    skipped_unattributed: skippedUnattributed,
    failed,
    duration_ms: Date.now() - t0,
    partial_pages: partialPages,
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
    return;
  }

  const result = await ingestPass(args);
  printBulkResult(result, args);
}

main().catch((err) => {
  console.error(`gstack-memory-ingest fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
