#!/usr/bin/env bun
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
import { join, basename } from "path";
import { execSync } from "child_process";
import { homedir } from "os";

// ── Types ──────────────────────────────────────────────────────────────────

interface Session {
  tool: "claude_code" | "codex" | "gemini";
  cwd: string;
}

interface Repo {
  name: string;
  remote: string;
  paths: string[];
  sessions: { claude_code: number; codex: number; gemini: number };
}

interface DiscoveryResult {
  window: string;
  start_date: string;
  repos: Repo[];
  tools: {
    claude_code: { total_sessions: number; repos: number };
    codex: { total_sessions: number; repos: number };
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

Examples:
  gstack-global-discover --since 7d
  gstack-global-discover --since 14d --format summary`);
}

function parseArgs(): { since: string; format: "json" | "summary" } {
  const args = process.argv.slice(2);
  let since = "";
  let format: "json" | "summary" = "json";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--help" || args[i] === "-h") {
      printUsage();
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
  let normalized = url.trim();

  // SSH → HTTPS: git@github.com:user/repo → https://github.com/user/repo
  const sshMatch = normalized.match(/^(?:ssh:\/\/)?git@([^:]+):(.+)$/);
  if (sshMatch) {
    normalized = `https://${sshMatch[1]}/${sshMatch[2]}`;
  }

  // Strip .git suffix
  if (normalized.endsWith(".git")) {
    normalized = normalized.slice(0, -4);
  }

  // Lowercase the host portion
  try {
    const parsed = new URL(normalized);
    parsed.hostname = parsed.hostname.toLowerCase();
    normalized = parsed.toString();
    // Remove trailing slash
    if (normalized.endsWith("/")) {
      normalized = normalized.slice(0, -1);
    }
  } catch {
    // Not a valid URL (e.g., local:<path>), return as-is
  }

  return normalized;
}

// ── Git helpers ────────────────────────────────────────────────────────────

function isGitRepo(dir: string): boolean {
  return existsSync(join(dir, ".git"));
}

function getGitRemote(cwd: string): string | null {
  if (!existsSync(cwd) || !isGitRepo(cwd)) return null;
  try {
    const remote = execSync("git remote get-url origin", {
      cwd,
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    return remote || null;
  } catch {
    return null;
  }
}

// ── Scanners ───────────────────────────────────────────────────────────────

function scanClaudeCode(since: Date): Session[] {
  const projectsDir = join(homedir(), ".claude", "projects");
  if (!existsSync(projectsDir)) return [];

  const sessions: Session[] = [];

  let dirs: string[];
  try {
    dirs = readdirSync(projectsDir);
  } catch {
    return [];
  }

  for (const dirName of dirs) {
    const dirPath = join(projectsDir, dirName);
    try {
      const stat = statSync(dirPath);
      if (!stat.isDirectory()) continue;
    } catch {
      continue;
    }

    // Find JSONL files
    let jsonlFiles: string[];
    try {
      jsonlFiles = readdirSync(dirPath).filter((f) => f.endsWith(".jsonl"));
    } catch {
      continue;
    }
    if (jsonlFiles.length === 0) continue;

    // Coarse mtime pre-filter: check if any JSONL file is recent
    const hasRecentFile = jsonlFiles.some((f) => {
      try {
        return statSync(join(dirPath, f)).mtime >= since;
      } catch {
        return false;
      }
    });
    if (!hasRecentFile) continue;

    // Resolve cwd
    let cwd = resolveClaudeCodeCwd(dirPath, dirName, jsonlFiles);
    if (!cwd) continue;

    // Count only JSONL files modified within the window as sessions
    const recentFiles = jsonlFiles.filter((f) => {
      try {
        return statSync(join(dirPath, f)).mtime >= since;
      } catch {
        return false;
      }
    });
    for (let i = 0; i < recentFiles.length; i++) {
      sessions.push({ tool: "claude_code", cwd });
    }
  }

  return sessions;
}

function resolveClaudeCodeCwd(
  dirPath: string,
  dirName: string,
  jsonlFiles: string[]
): string | null {
  // Fast-path: decode directory name
  // e.g., -Users-garrytan-git-repo → /Users/garrytan/git/repo
  const decoded = dirName.replace(/^-/, "/").replace(/-/g, "/");
  if (existsSync(decoded)) return decoded;

  // Fallback: read cwd from first JSONL file
  // Sort by mtime descending, pick most recent
  const sorted = jsonlFiles
    .map((f) => {
      try {
        return { name: f, mtime: statSync(join(dirPath, f)).mtime.getTime() };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => b!.mtime - a!.mtime) as { name: string; mtime: number }[];

  for (const file of sorted.slice(0, 3)) {
    const cwd = extractCwdFromJsonl(join(dirPath, file.name));
    if (cwd && existsSync(cwd)) return cwd;
  }

  return null;
}

function extractCwdFromJsonl(filePath: string): string | null {
  try {
    // Read only the first 8KB to avoid loading huge JSONL files into memory
    const fd = openSync(filePath, "r");
    const buf = Buffer.alloc(8192);
    const bytesRead = readSync(fd, buf, 0, 8192, 0);
    closeSync(fd);
    const text = buf.toString("utf-8", 0, bytesRead);
    const lines = text.split("\n").slice(0, 15);
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        if (obj.cwd) return obj.cwd;
      } catch {
        continue;
      }
    }
  } catch {
    // File read error
  }
  return null;
}

function scanCodex(since: Date): Session[] {
  const sessionsDir = join(homedir(), ".codex", "sessions");
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

            // Read first line for session_meta (only first 4KB)
            try {
              const fd = openSync(filePath, "r");
              const buf = Buffer.alloc(4096);
              const bytesRead = readSync(fd, buf, 0, 4096, 0);
              closeSync(fd);
              const firstLine = buf.toString("utf-8", 0, bytesRead).split("\n")[0];
              if (!firstLine) continue;
              const meta = JSON.parse(firstLine);
              if (meta.type === "session_meta" && meta.payload?.cwd) {
                sessions.push({ tool: "codex", cwd: meta.payload.cwd });
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
  } catch {
    return [];
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
  // Group sessions by cwd
  const byCwd = new Map<string, Session[]>();
  for (const s of sessions) {
    const existing = byCwd.get(s.cwd) || [];
    existing.push(s);
    byCwd.set(s.cwd, existing);
  }

  // Resolve git remotes for each cwd
  const cwds = Array.from(byCwd.keys());
  const remoteMap = new Map<string, string>(); // cwd → normalized remote

  for (const cwd of cwds) {
    const raw = getGitRemote(cwd);
    if (raw) {
      remoteMap.set(cwd, normalizeRemoteUrl(raw));
    } else if (existsSync(cwd) && isGitRepo(cwd)) {
      remoteMap.set(cwd, `local:${cwd}`);
    }
  }

  // Group by normalized remote
  const byRemote = new Map<string, { paths: string[]; sessions: Session[] }>();
  for (const [cwd, cwdSessions] of byCwd) {
    const remote = remoteMap.get(cwd);
    if (!remote) continue;

    const existing = byRemote.get(remote) || { paths: [], sessions: [] };
    if (!existing.paths.includes(cwd)) existing.paths.push(cwd);
    existing.sessions.push(...cwdSessions);
    byRemote.set(remote, existing);
  }

  // Build Repo objects
  const repos: Repo[] = [];
  for (const [remote, data] of byRemote) {
    // Find first valid path
    const validPath = data.paths.find((p) => existsSync(p) && isGitRepo(p));
    if (!validPath) continue;

    // Derive name from remote URL
    let name: string;
    if (remote.startsWith("local:")) {
      name = basename(remote.replace("local:", ""));
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
  const ccSessions = scanClaudeCode(sinceDate);
  const codexSessions = scanCodex(sinceDate);
  const geminiSessions = scanGemini(sinceDate);

  const allSessions = [...ccSessions, ...codexSessions, ...geminiSessions];

  // Summary to stderr
  console.error(
    `Discovered: ${ccSessions.length} CC sessions, ${codexSessions.length} Codex sessions, ${geminiSessions.length} Gemini sessions`
  );

  // Deduplicate
  const repos = await resolveAndDeduplicate(allSessions);

  console.error(`→ ${repos.length} unique repos`);

  // Count per-tool repo counts
  const ccRepos = new Set(repos.filter((r) => r.sessions.claude_code > 0).map((r) => r.remote)).size;
  const codexRepos = new Set(repos.filter((r) => r.sessions.codex > 0).map((r) => r.remote)).size;
  const geminiRepos = new Set(repos.filter((r) => r.sessions.gemini > 0).map((r) => r.remote)).size;

  const result: DiscoveryResult = {
    window: since,
    start_date: startDate,
    repos,
    tools: {
      claude_code: { total_sessions: ccSessions.length, repos: ccRepos },
      codex: { total_sessions: codexSessions.length, repos: codexRepos },
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
    console.log(`Repos: ${repos.length} unique`);
    console.log("");
    for (const repo of repos) {
      const total = repo.sessions.claude_code + repo.sessions.codex + repo.sessions.gemini;
      const tools = [];
      if (repo.sessions.claude_code > 0) tools.push(`CC:${repo.sessions.claude_code}`);
      if (repo.sessions.codex > 0) tools.push(`Codex:${repo.sessions.codex}`);
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
