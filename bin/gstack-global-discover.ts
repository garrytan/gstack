#!/usr/bin/env -S bun --no-env-file --config=/dev/null
/**
 * gstack-global-discover — Discover AI coding sessions across Claude Code, Codex CLI, and Gemini CLI.
 * Resolves each session's working directory to a git repo, deduplicates by normalized remote URL,
 * and outputs structured JSON to stdout.
 *
 * Usage:
 *   gstack-global-discover --since 7d [--format json|summary]
 *   gstack-global-discover --help
 */

import { existsSync, readdirSync, statSync, readFileSync, openSync, readSync, closeSync } from "fs";
import { join, basename, dirname, resolve } from "path";
import { spawnSync } from "child_process";
import { homedir } from "os";
import { canonicalRemote } from "../lib/remote-identity";

// ── Types ──────────────────────────────────────────────────────────────────

type CodexOriginator = "cli" | "desktop" | "exec" | "claude_code" | "other";
type CodexOriginatorCounts = Record<CodexOriginator, number>;

interface Session {
  tool: "claude_code" | "codex" | "gemini";
  cwd: string;
  codexOriginator?: CodexOriginator;
}

interface Repo {
  name: string;
  remote: string;
  paths: string[];
  sessions: { claude_code: number; codex: number; gemini: number };
  codex_originators: CodexOriginatorCounts;
}

interface DiscoveryResult {
  window: string;
  start_date: string;
  repos: Repo[];
  tools: {
    claude_code: { total_sessions: number; repos: number };
    codex: { total_sessions: number; repos: number; originators: CodexOriginatorCounts };
    gemini: { total_sessions: number; repos: number };
  };
  total_sessions: number;
  total_repos: number;
}

// ── CLI parsing ────────────────────────────────────────────────────────────

function printUsage(): void {
  console.error(`Usage: gstack-global-discover --since <window> [--format json|summary]

  --since <window>   Time window: e.g. 7d, 14d, 30d, 24h
  --format <fmt>     Output format: json (default) or summary
  --help             Show this help
  --version          Print the gstack version and exit (no scan)

Examples:
  gstack-global-discover --since 7d
  gstack-global-discover --since 14d --format summary`);
}

function readGstackVersion(): string {
  // The compiled binary and this source file both live in bin/, one level below VERSION.
  for (const dir of [dirname(process.execPath), import.meta.dir]) {
    try {
      const version = readFileSync(join(dir, "..", "VERSION"), "utf8").trim();
      if (version) return version;
    } catch {}
  }
  return "unknown";
}

function parseArgs(): { since: string; format: "json" | "summary" } {
  const args = process.argv.slice(2);
  let since = "";
  let format: "json" | "summary" = "json";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--help" || args[i] === "-h") {
      printUsage();
      process.exit(0);
    } else if (args[i] === "--version") {
      // setup's and gstack-doctor's launch probe (#2595): exits before any scan.
      console.log(readGstackVersion());
      process.exit(0);
    } else if (args[i] === "--since" && args[i + 1]) {
      since = args[++i];
    } else if (args[i] === "--format" && args[i + 1]) {
      const f = args[++i];
      if (f !== "json" && f !== "summary") {
        console.error(`Invalid format: ${f}. Use 'json' or 'summary'.`);
        printUsage();
        process.exit(1);
      }
      format = f;
    } else {
      console.error(`Unknown argument: ${args[i]}`);
      printUsage();
      process.exit(1);
    }
  }

  if (!since) {
    console.error("Error: --since is required.");
    printUsage();
    process.exit(1);
  }

  if (!/^\d+(d|h|w)$/.test(since)) {
    console.error(`Invalid window format: ${since}. Use e.g. 7d, 24h, 2w.`);
    process.exit(1);
  }

  return { since, format };
}

function windowToDate(window: string): Date {
  const match = window.match(/^(\d+)(d|h|w)$/);
  if (!match) throw new Error(`Invalid window: ${window}`);
  const [, numStr, unit] = match;
  const num = parseInt(numStr, 10);
  const now = new Date();

  if (unit === "h") {
    return new Date(now.getTime() - num * 60 * 60 * 1000);
  } else if (unit === "w") {
    // weeks — midnight-aligned like days
    const d = new Date(now);
    d.setDate(d.getDate() - num * 7);
    d.setHours(0, 0, 0, 0);
    return d;
  } else {
    // days — midnight-aligned
    const d = new Date(now);
    d.setDate(d.getDate() - num);
    d.setHours(0, 0, 0, 0);
    return d;
  }
}

// ── URL normalization ──────────────────────────────────────────────────────

export function normalizeRemoteUrl(url: string): string {
  // One identity per repository whichever way it was cloned (ssh, ssh:// with
  // a port, https with credentials): the shared canonical remote from
  // lib/remote-identity.ts, rendered as an https URL for display.
  const id = canonicalRemote(url.trim());
  return id.hosted ? `https://${id.canonical}` : url.trim();
}

// ── Git helpers ────────────────────────────────────────────────────────────

interface GitProject {
  /** Worktree root the session ran in (a linked worktree is its own root). */
  root: string;
  /** The repository's main worktree, shared by its linked worktrees. */
  main: string;
}

const PROJECT_MEMO = new Map<string, GitProject | null>();

/**
 * The git project a session's recorded cwd belongs to: its worktree root and
 * the repository it shares with linked worktrees. A subdirectory resolves to
 * the same root as the root itself; a cwd outside any work tree (a plain
 * directory, or inside .git) has no project.
 */
function gitProject(cwd: string): GitProject | null {
  const memo = PROJECT_MEMO.get(cwd);
  if (memo !== undefined) return memo;
  let project: GitProject | null = null;
  if (existsSync(cwd)) {
    const r = spawnSync("git", ["-C", cwd, "rev-parse", "--is-inside-work-tree", "--show-prefix", "--path-format=absolute", "--git-common-dir"], {
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const [inside, prefix, common] = r.status === 0 ? r.stdout.replace(/\r?\n$/, "").split(/\r?\n/) : [];
    if (inside === "true" && prefix !== undefined && common) {
      // Strip the prefix from the recorded cwd instead of taking git's
      // --show-toplevel, so the root keeps the session's own spelling
      // (a symlinked home, a native Windows drive path).
      const up = prefix.split("/").filter(Boolean).map(() => "..");
      project = { root: resolve(cwd, ...up), main: basename(common) === ".git" ? dirname(common) : common };
    }
  } else {
    // A merged branch's worktree is removed but its session history stays:
    // count those sessions with the repository the worktree was created from.
    const parent = parentRepoOfClaudeWorktree(cwd);
    if (parent) project = gitProject(parent);
  }
  PROJECT_MEMO.set(cwd, project);
  return project;
}

/**
 * Claude Code creates worktrees at `<repo>/.claude/worktrees/<name>`. Given a
 * cwd inside one (the worktree root or any subdirectory), the repository root
 * it was created from; null for any other path.
 */
export function parentRepoOfClaudeWorktree(cwd: string): string | null {
  const m = cwd.match(/^(.+?)[\\/]\.claude[\\/]worktrees[\\/][^\\/]+(?:[\\/].*)?$/);
  return m ? m[1] : null;
}

function getGitRemote(root: string): string | null {
  const r = spawnSync("git", ["-C", root, "remote", "get-url", "origin"], {
    encoding: "utf-8",
    timeout: 5000,
    stdio: ["ignore", "pipe", "ignore"],
  });
  return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : null;
}

// ── Scanners ───────────────────────────────────────────────────────────────

/** JSONL lines longer than this are skipped (and counted) while looking for a session's cwd. */
const MAX_CWD_LINE_BYTES = 1024 * 1024;
const MAX_CWD_LINES = 30;
const MAX_CWD_SCAN_BYTES = 16 * 1024 * 1024;

export interface CwdScanStats {
  oversizedLines: number;
}

function scanClaudeCode(since: Date, stats: CwdScanStats): Session[] {
  const projectsDir = join(homedir(), ".claude", "projects");
  if (!existsSync(projectsDir)) return [];

  const sessions: Session[] = [];

  let dirs: string[];
  try {
    dirs = readdirSync(projectsDir);
  } catch (err: any) {
    if (err?.code === 'ENOENT' || err?.code === 'EACCES') return [];
    throw err;
  }

  for (const dirName of dirs) {
    const dirPath = join(projectsDir, dirName);
    let recentFiles: string[];
    try {
      if (!statSync(dirPath).isDirectory()) continue;
      recentFiles = readdirSync(dirPath).filter((f) => {
        if (!f.endsWith(".jsonl")) return false;
        try {
          return statSync(join(dirPath, f)).mtime >= since;
        } catch {
          return false;
        }
      });
    } catch {
      continue;
    }

    // The project is the cwd each session recorded, never the directory name:
    // Claude Code encodes "/" and "-" alike as "-", so the name cannot be
    // decoded (#1315). A session that recorded no cwd in its first lines
    // belongs to the same project as its siblings in this directory.
    const cwds = recentFiles.map((f) => extractCwdFromJsonl(join(dirPath, f), stats));
    const sibling = cwds.find((c): c is string => !!c);
    for (const cwd of cwds) {
      const resolved = cwd ?? sibling;
      if (resolved) sessions.push({ tool: "claude_code", cwd: resolved });
    }
  }

  return sessions;
}

/**
 * The cwd recorded in the first lines of a session JSONL. Lines are read whole
 * up to 1 MiB each (Claude Code can open with a queue-operation record far
 * larger than a fixed prefix); a longer line is skipped and counted in
 * `stats.oversizedLines`, and the scan moves on to the next line.
 */
export function extractCwdFromJsonl(filePath: string, stats: CwdScanStats = { oversizedLines: 0 }): string | null {
  let fd: number;
  try {
    fd = openSync(filePath, "r");
  } catch {
    return null;
  }
  try {
    const chunk = Buffer.alloc(64 * 1024);
    let pieces: Buffer[] = [];
    let lineBytes = 0;
    let lines = 0;
    let position = 0;
    const endLine = (): string | null => {
      lines++;
      const oversized = lineBytes > MAX_CWD_LINE_BYTES;
      const text = oversized ? "" : Buffer.concat(pieces).toString("utf-8");
      pieces = [];
      lineBytes = 0;
      if (oversized) {
        stats.oversizedLines++;
        return null;
      }
      if (!text.trim()) return null;
      try {
        const obj = JSON.parse(text);
        return typeof obj?.cwd === "string" && obj.cwd ? obj.cwd : null;
      } catch {
        return null;
      }
    };
    const keep = (part: Buffer) => {
      lineBytes += part.length;
      if (lineBytes <= MAX_CWD_LINE_BYTES) pieces.push(Buffer.from(part));
      else pieces = [];
    };
    while (lines < MAX_CWD_LINES && position < MAX_CWD_SCAN_BYTES) {
      const n = readSync(fd, chunk, 0, chunk.length, position);
      if (n === 0) return lineBytes > 0 ? endLine() : null;
      position += n;
      const data = chunk.subarray(0, n);
      let start = 0;
      for (let nl = data.indexOf(10, start); nl !== -1; nl = data.indexOf(10, start)) {
        keep(data.subarray(start, nl));
        start = nl + 1;
        const cwd = endLine();
        if (cwd) return cwd;
        if (lines >= MAX_CWD_LINES) return null;
      }
      keep(data.subarray(start));
    }
    return null;
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

// Separates interactive Codex CLI and Desktop work from codex exec runs and
// Claude Code-driven calls. The interactive CLI's default originator is
// codex_cli_rs. Missing, unknown and non-string values count as "other",
// so the buckets always sum to the Codex session total.
function normalizeCodexOriginator(raw: unknown): CodexOriginator {
  if (typeof raw !== "string") return "other";
  const value = raw.trim().toLowerCase();
  if (value === "codex_cli_rs") return "cli";
  if (value === "codex desktop" || value === "codex_desktop") return "desktop";
  if (value === "codex_exec" || value === "codex exec") return "exec";
  if (value === "claude code" || value === "claude_code") return "claude_code";
  return "other";
}

function countCodexOriginators(sessions: Session[]): CodexOriginatorCounts {
  const counts: CodexOriginatorCounts = { cli: 0, desktop: 0, exec: 0, claude_code: 0, other: 0 };
  for (const s of sessions) {
    if (s.tool === "codex") counts[s.codexOriginator ?? "other"]++;
  }
  return counts;
}

function formatCodexOriginators(o: CodexOriginatorCounts): string {
  return `cli=${o.cli}, desktop=${o.desktop}, exec=${o.exec}, claude_code=${o.claude_code}, other=${o.other}`;
}

function scanCodex(since: Date): Session[] {
  const sessionsDir = process.env.CODEX_SESSIONS_DIR || join(homedir(), ".codex", "sessions");
  if (!existsSync(sessionsDir)) return [];

  const sessions: Session[] = [];

  // Walk YYYY/MM/DD directory structure
  try {
    const years = readdirSync(sessionsDir);
    for (const year of years) {
      const yearPath = join(sessionsDir, year);
      if (!statSync(yearPath).isDirectory()) continue;

      const months = readdirSync(yearPath);
      for (const month of months) {
        const monthPath = join(yearPath, month);
        if (!statSync(monthPath).isDirectory()) continue;

        const days = readdirSync(monthPath);
        for (const day of days) {
          const dayPath = join(monthPath, day);
          if (!statSync(dayPath).isDirectory()) continue;

          const files = readdirSync(dayPath).filter((f) =>
            f.startsWith("rollout-") && f.endsWith(".jsonl")
          );

          for (const file of files) {
            const filePath = join(dayPath, file);
            try {
              const stat = statSync(filePath);
              if (stat.mtime < since) continue;
            } catch {
              continue;
            }

            // Codex session_meta lines embed the full system prompt in
            // base_instructions (~15KB as of CLI v0.117+). A 4KB buffer
            // truncates the line and JSON.parse fails. 128KB covers current
            // sizes with room for growth.
            try {
              const fd = openSync(filePath, "r");
              const buf = Buffer.alloc(131072);
              const bytesRead = readSync(fd, buf, 0, 131072, 0);
              closeSync(fd);
              const firstLine = buf.toString("utf-8", 0, bytesRead).split("\n")[0];
              if (!firstLine) continue;
              const meta = JSON.parse(firstLine);
              if (meta.type === "session_meta" && meta.payload?.cwd) {
                sessions.push({
                  tool: "codex",
                  cwd: meta.payload.cwd,
                  codexOriginator: normalizeCodexOriginator(meta.payload.originator),
                });
              }
            } catch {
              console.error(`Warning: could not parse Codex session ${filePath}`);
            }
          }
        }
      }
    }
  } catch {
    // Directory read error
  }

  return sessions;
}

function scanGemini(since: Date): Session[] {
  const tmpDir = join(homedir(), ".gemini", "tmp");
  if (!existsSync(tmpDir)) return [];

  // Load projects.json for path mapping
  const projectsPath = join(homedir(), ".gemini", "projects.json");
  let projectsMap: Record<string, string> = {}; // name → path
  if (existsSync(projectsPath)) {
    try {
      const data = JSON.parse(readFileSync(projectsPath, { encoding: "utf-8" }));
      // Format: { projects: { "/path": "name" } } — we want name → path
      const projects = data.projects || {};
      for (const [path, name] of Object.entries(projects)) {
        projectsMap[name as string] = path;
      }
    } catch {
      console.error("Warning: could not parse ~/.gemini/projects.json");
    }
  }

  const sessions: Session[] = [];
  const seenTimestamps = new Map<string, Set<string>>(); // projectName → Set<startTime>

  let projectDirs: string[];
  try {
    projectDirs = readdirSync(tmpDir);
  } catch (err: any) {
    if (err?.code === 'ENOENT' || err?.code === 'EACCES') return [];
    throw err;
  }

  for (const projectName of projectDirs) {
    const chatsDir = join(tmpDir, projectName, "chats");
    if (!existsSync(chatsDir)) continue;

    // Resolve cwd from projects.json
    let cwd = projectsMap[projectName] || null;

    // Fallback: check .project_root
    if (!cwd) {
      const projectRootFile = join(tmpDir, projectName, ".project_root");
      if (existsSync(projectRootFile)) {
        try {
          cwd = readFileSync(projectRootFile, { encoding: "utf-8" }).trim();
        } catch {}
      }
    }

    if (!cwd || !existsSync(cwd)) continue;

    const seen = seenTimestamps.get(projectName) || new Set<string>();
    seenTimestamps.set(projectName, seen);

    let files: string[];
    try {
      files = readdirSync(chatsDir).filter((f) =>
        f.startsWith("session-") && f.endsWith(".json")
      );
    } catch {
      continue;
    }

    for (const file of files) {
      const filePath = join(chatsDir, file);
      try {
        const stat = statSync(filePath);
        if (stat.mtime < since) continue;
      } catch {
        continue;
      }

      try {
        const data = JSON.parse(readFileSync(filePath, { encoding: "utf-8" }));
        const startTime = data.startTime || "";

        // Deduplicate by startTime within project
        if (startTime && seen.has(startTime)) continue;
        if (startTime) seen.add(startTime);

        sessions.push({ tool: "gemini", cwd });
      } catch {
        console.error(`Warning: could not parse Gemini session ${filePath}`);
      }
    }
  }

  return sessions;
}

// ── Deduplication ──────────────────────────────────────────────────────────

async function resolveAndDeduplicate(sessions: Session[]): Promise<Repo[]> {
  // Group sessions by repository: the origin remote when there is one, else
  // the main worktree, so linked worktrees and subdirectories of one
  // repository count together and a nested repository counts as its own.
  const byRemote = new Map<string, { main: string; paths: string[]; sessions: Session[] }>();
  for (const s of sessions) {
    const project = gitProject(s.cwd);
    if (!project) continue;
    const raw = getGitRemote(project.root);
    const remote = raw ? normalizeRemoteUrl(raw) : `local:${project.main}`;
    const existing = byRemote.get(remote) || { main: project.main, paths: [], sessions: [] };
    if (!existing.paths.includes(project.root)) existing.paths.push(project.root);
    existing.sessions.push(s);
    byRemote.set(remote, existing);
  }

  // Build Repo objects
  const repos: Repo[] = [];
  for (const [remote, data] of byRemote) {
    // Derive name from remote URL
    let name: string;
    if (remote.startsWith("local:")) {
      name = basename(data.main);
    } else {
      try {
        const url = new URL(remote);
        name = basename(url.pathname);
      } catch {
        name = basename(remote);
      }
    }

    const sessionCounts = { claude_code: 0, codex: 0, gemini: 0 };
    for (const s of data.sessions) {
      sessionCounts[s.tool]++;
    }

    repos.push({
      name,
      remote,
      paths: data.paths,
      sessions: sessionCounts,
      codex_originators: countCodexOriginators(data.sessions),
    });
  }

  // Sort by total sessions descending
  repos.sort(
    (a, b) =>
      b.sessions.claude_code + b.sessions.codex + b.sessions.gemini -
      (a.sessions.claude_code + a.sessions.codex + a.sessions.gemini)
  );

  return repos;
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const { since, format } = parseArgs();
  const sinceDate = windowToDate(since);
  const startDate = sinceDate.toISOString().split("T")[0];

  // Run all scanners
  const cwdStats: CwdScanStats = { oversizedLines: 0 };
  const ccSessions = scanClaudeCode(sinceDate, cwdStats);
  const codexSessions = scanCodex(sinceDate);
  const geminiSessions = scanGemini(sinceDate);

  const allSessions = [...ccSessions, ...codexSessions, ...geminiSessions];

  // Summary to stderr
  console.error(
    `Discovered: ${ccSessions.length} CC sessions, ${codexSessions.length} Codex sessions, ${geminiSessions.length} Gemini sessions`
  );

  if (cwdStats.oversizedLines > 0) {
    console.error(
      `Skipped ${cwdStats.oversizedLines} Claude Code JSONL line(s) over 1 MiB while reading session cwds; ` +
        `a session whose cwd appears only after such lines counts with its project directory's other sessions.`,
    );
  }

  // Deduplicate
  const repos = await resolveAndDeduplicate(allSessions);

  console.error(`→ ${repos.length} unique repos`);

  // Count per-tool repo counts
  const ccRepos = new Set(repos.filter((r) => r.sessions.claude_code > 0).map((r) => r.remote)).size;
  const codexRepos = new Set(repos.filter((r) => r.sessions.codex > 0).map((r) => r.remote)).size;
  const geminiRepos = new Set(repos.filter((r) => r.sessions.gemini > 0).map((r) => r.remote)).size;

  const codexOriginators = countCodexOriginators(codexSessions);

  const result: DiscoveryResult = {
    window: since,
    start_date: startDate,
    repos,
    tools: {
      claude_code: { total_sessions: ccSessions.length, repos: ccRepos },
      codex: { total_sessions: codexSessions.length, repos: codexRepos, originators: codexOriginators },
      gemini: { total_sessions: geminiSessions.length, repos: geminiRepos },
    },
    total_sessions: allSessions.length,
    total_repos: repos.length,
  };

  if (format === "json") {
    console.log(JSON.stringify(result, null, 2));
  } else {
    // Summary format
    console.log(`Window: ${since} (since ${startDate})`);
    console.log(`Sessions: ${allSessions.length} total (CC: ${ccSessions.length}, Codex: ${codexSessions.length}, Gemini: ${geminiSessions.length})`);
    if (codexSessions.length > 0) console.log(`  Codex originators: ${formatCodexOriginators(codexOriginators)}`);
    console.log(`Repos: ${repos.length} unique`);
    console.log("");
    for (const repo of repos) {
      const total = repo.sessions.claude_code + repo.sessions.codex + repo.sessions.gemini;
      const tools = [];
      if (repo.sessions.claude_code > 0) tools.push(`CC:${repo.sessions.claude_code}`);
      if (repo.sessions.codex > 0) tools.push(`Codex:${repo.sessions.codex} (${formatCodexOriginators(repo.codex_originators)})`);
      if (repo.sessions.gemini > 0) tools.push(`Gemini:${repo.sessions.gemini}`);
      console.log(`  ${repo.name} (${total} sessions) — ${tools.join(", ")}`);
      console.log(`    Remote: ${repo.remote}`);
      console.log(`    Paths: ${repo.paths.join(", ")}`);
    }
  }
}

// Only run main when executed directly (not when imported for testing)
if (import.meta.main) {
  main().catch((err) => {
    console.error(`Fatal error: ${err.message}`);
    process.exit(1);
  });
}
