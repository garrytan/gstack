#!/usr/bin/env bun
/**
 * gstack-meditate — Proactive repo consciousness scanner.
 *
 * Scans repo structure, git history, and past AI conversations (Claude Code,
 * Codex CLI, Gemini CLI) to produce a raw JSON snapshot. Optionally generates
 * a template-based .gstack/context.md (--background mode).
 *
 * Usage:
 *   gstack-meditate --repo <path> [--output <path>] [--background]
 *   gstack-meditate --help
 */

import {
  existsSync, readdirSync, statSync, readFileSync, writeFileSync,
  openSync, readSync, closeSync, mkdirSync, renameSync, unlinkSync,
} from "fs";
import { join, basename, relative, resolve } from "path";
import { execSync, spawnSync } from "child_process";
import { homedir, tmpdir } from "os";

// ── Types ──────────────────────────────────────────────────────────────────

interface RepoSnapshot {
  version: number;
  timestamp: string;
  duration_ms: number;
  repo: {
    slug: string;
    remote: string;
    languages: string[];
    framework: string;
    structure: Record<string, string[]>;
    file_count: number;
    test_coverage_map: Record<string, string>;
  };
  activity: {
    commits_30d: number;
    contributors: string[];
    hotspots: string[];
    cold_spots: string[];
    todos: { file: string; line: number; text: string }[];
  };
  conversations: {
    sessions_analyzed: number;
    sessions_skipped: number;
    by_tool: { claude_code: number; codex: number; gemini: number };
    most_referenced_files: string[];
    recurring_errors: string[];
    recurring_topics: string[];
    workflow_patterns: string[];
  };
  docs: {
    claude_md: string;
    todos_md: string;
    readme_md: string;
  };
  partial: boolean;
}

interface ConversationSession {
  tool: "claude_code" | "codex" | "gemini";
  filePath: string;
  cwd: string;
  mtime: Date;
}

interface ExtractedPatterns {
  referencedFiles: Map<string, number>;
  errors: Map<string, number>;
  topics: Map<string, number>;
  workflows: Map<string, number>;
  sessionsAnalyzed: number;
  sessionsSkipped: number;
  byTool: { claude_code: number; codex: number; gemini: number };
}

// ── CLI ────────────────────────────────────────────────────────────────────

function printUsage(): void {
  console.error(`Usage: gstack-meditate --repo <path> [--output <path>] [--background]

  --repo <path>      Repository root to scan
  --output <path>    Output path for JSON snapshot (default: auto)
  --background       Also produce template-based .gstack/context.md (no LLM)
  --help             Show this help`);
}

function parseArgs(): { repo: string; output: string; background: boolean } {
  const args = process.argv.slice(2);
  let repo = "";
  let output = "";
  let background = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--help" || args[i] === "-h") {
      printUsage();
      process.exit(0);
    } else if (args[i] === "--repo" && args[i + 1]) {
      repo = args[++i];
    } else if (args[i] === "--output" && args[i + 1]) {
      output = args[++i];
    } else if (args[i] === "--background") {
      background = true;
    }
  }

  if (!repo) {
    repo = process.cwd();
  }

  return { repo: resolve(repo), output, background };
}

// ── Slug derivation ────────────────────────────────────────────────────────

export function deriveSlug(repoPath: string): string {
  try {
    const remote = execSync("git remote get-url origin", {
      cwd: repoPath, stdio: ["pipe", "pipe", "pipe"], timeout: 5000,
    }).toString().trim();
    // Extract owner/repo from URL
    const match = remote.match(/[:/]([^/]+\/[^/]+?)(?:\.git)?$/);
    if (match) {
      return match[1].replace("/", "-").replace(/[^a-zA-Z0-9._-]/g, "");
    }
  } catch {}
  return basename(repoPath).replace(/[^a-zA-Z0-9._-]/g, "");
}

// ── Repo scanning ──────────────────────────────────────────────────────────

export function scanRepoStructure(repoPath: string, maxDepth = 4): Record<string, string[]> {
  const structure: Record<string, string[]> = {};
  const ignoreSet = new Set([
    "node_modules", ".git", "dist", "build", ".next", "__pycache__",
    "vendor", ".bundle", "target", "coverage", ".gstack",
  ]);

  function walk(dir: string, depth: number): void {
    if (depth > maxDepth) return;
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      const rel = relative(repoPath, dir) || ".";
      const children: string[] = [];
      for (const e of entries) {
        if (e.name.startsWith(".") && e.name !== ".github") continue;
        if (ignoreSet.has(e.name)) continue;
        children.push(e.isDirectory() ? `${e.name}/` : e.name);
        if (e.isDirectory()) walk(join(dir, e.name), depth + 1);
      }
      if (children.length > 0) structure[rel] = children;
    } catch {}
  }

  walk(repoPath, 0);
  return structure;
}

export function detectLanguages(repoPath: string): { languages: string[]; framework: string } {
  const languages: string[] = [];
  const detectors: [string, string][] = [
    ["package.json", "typescript"],
    ["tsconfig.json", "typescript"],
    ["Gemfile", "ruby"],
    ["pyproject.toml", "python"],
    ["requirements.txt", "python"],
    ["go.mod", "go"],
    ["Cargo.toml", "rust"],
    ["pom.xml", "java"],
    ["build.gradle", "java"],
    ["composer.json", "php"],
    ["mix.exs", "elixir"],
    ["Makefile", "c/c++"],
  ];

  for (const [file, lang] of detectors) {
    if (existsSync(join(repoPath, file)) && !languages.includes(lang)) {
      languages.push(lang);
    }
  }

  // Check for bash/shell scripts
  try {
    const result = spawnSync("find", [repoPath, "-maxdepth", "3", "-name", "*.sh", "-type", "f"], {
      timeout: 3000, stdio: ["pipe", "pipe", "pipe"],
    });
    if (result.stdout?.toString().trim()) languages.push("bash");
  } catch {}

  let framework = "unknown";
  if (existsSync(join(repoPath, "bun.lock")) || existsSync(join(repoPath, "bunfig.toml"))) {
    framework = "bun";
  } else if (existsSync(join(repoPath, "next.config.js")) || existsSync(join(repoPath, "next.config.ts"))) {
    framework = "nextjs";
  } else if (existsSync(join(repoPath, "vite.config.ts")) || existsSync(join(repoPath, "vite.config.js"))) {
    framework = "vite";
  } else if (existsSync(join(repoPath, "Gemfile"))) {
    framework = "rails";
  } else if (existsSync(join(repoPath, "package.json"))) {
    framework = "node";
  }

  return { languages: languages.length ? languages : ["unknown"], framework };
}

export function scanGitActivity(repoPath: string): {
  commits_30d: number; contributors: string[]; hotspots: string[]; cold_spots: string[];
} {
  const result = { commits_30d: 0, contributors: [] as string[], hotspots: [] as string[], cold_spots: [] as string[] };

  try {
    // Commit count
    const countOut = execSync('git log --since="30 days" --oneline 2>/dev/null | wc -l', {
      cwd: repoPath, timeout: 10000, stdio: ["pipe", "pipe", "pipe"],
    }).toString().trim();
    result.commits_30d = parseInt(countOut, 10) || 0;

    // Contributors
    const authorsOut = execSync('git log --since="30 days" --format="%an" 2>/dev/null | sort -u', {
      cwd: repoPath, timeout: 10000, stdio: ["pipe", "pipe", "pipe"],
    }).toString().trim();
    result.contributors = authorsOut.split("\n").filter(Boolean);

    // Hotspots (most-changed files)
    const hotOut = execSync('git log --since="30 days" --name-only --format="" 2>/dev/null | sort | uniq -c | sort -rn | head -15', {
      cwd: repoPath, timeout: 10000, stdio: ["pipe", "pipe", "pipe"],
    }).toString().trim();
    result.hotspots = hotOut.split("\n").filter(Boolean).map(l => l.trim().replace(/^\d+\s+/, "")).filter(Boolean);

    // Cold spots (files not touched in 6+ months but in the tree)
    const coldOut = execSync('git log --since="180 days" --name-only --format="" 2>/dev/null | sort -u', {
      cwd: repoPath, timeout: 10000, stdio: ["pipe", "pipe", "pipe"],
    }).toString().trim();
    const recentFiles = new Set(coldOut.split("\n").filter(Boolean));
    try {
      const allFiles = execSync('git ls-files 2>/dev/null | head -500', {
        cwd: repoPath, timeout: 5000, stdio: ["pipe", "pipe", "pipe"],
      }).toString().trim().split("\n").filter(Boolean);
      result.cold_spots = allFiles.filter(f => !recentFiles.has(f)).slice(0, 10);
    } catch {}
  } catch {}

  return result;
}

export function scanTodos(repoPath: string, limit = 100): { file: string; line: number; text: string }[] {
  const todos: { file: string; line: number; text: string }[] = [];
  try {
    const out = execSync(
      'grep -rn "TODO\\|FIXME\\|HACK\\|XXX" --include="*.ts" --include="*.js" --include="*.py" --include="*.rb" --include="*.go" --include="*.rs" --include="*.md" . 2>/dev/null | head -' + limit,
      { cwd: repoPath, timeout: 10000, stdio: ["pipe", "pipe", "pipe"] },
    ).toString().trim();
    for (const line of out.split("\n").filter(Boolean)) {
      const match = line.match(/^\.\/(.+?):(\d+):(.+)$/);
      if (match) {
        todos.push({ file: match[1], line: parseInt(match[2], 10), text: match[3].trim().slice(0, 120) });
      }
    }
  } catch {}
  return todos;
}

export function mapTestCoverage(repoPath: string): Record<string, string> {
  const map: Record<string, string> = {};
  const testPatterns = [
    (f: string) => f.replace(/\.ts$/, ".test.ts"),
    (f: string) => f.replace(/^src\//, "test/").replace(/\.ts$/, ".test.ts"),
    (f: string) => f.replace(/^src\//, "__tests__/").replace(/\.ts$/, ".test.ts"),
    (f: string) => f.replace(/\.py$/, "_test.py"),
    (f: string) => `test_${basename(f)}`,
  ];

  try {
    const files = execSync('git ls-files "*.ts" "*.py" "*.rb" "*.js" 2>/dev/null | head -200', {
      cwd: repoPath, timeout: 5000, stdio: ["pipe", "pipe", "pipe"],
    }).toString().trim().split("\n").filter(Boolean);

    for (const file of files) {
      if (file.includes(".test.") || file.includes("_test.") || file.startsWith("test/")) continue;
      for (const pattern of testPatterns) {
        const testFile = pattern(file);
        if (existsSync(join(repoPath, testFile))) {
          map[file] = testFile;
          break;
        }
      }
    }
  } catch {}
  return map;
}

export function extractDocs(repoPath: string): { claude_md: string; todos_md: string; readme_md: string } {
  const readFirst = (name: string, maxBytes = 2048): string => {
    const p = join(repoPath, name);
    if (!existsSync(p)) return "";
    try {
      const fd = openSync(p, "r");
      const buf = Buffer.alloc(maxBytes);
      const n = readSync(fd, buf, 0, maxBytes, 0);
      closeSync(fd);
      return buf.toString("utf-8", 0, n);
    } catch { return ""; }
  };
  return {
    claude_md: readFirst("CLAUDE.md"),
    todos_md: readFirst("TODOS.md"),
    readme_md: readFirst("README.md"),
  };
}

// ── Conversation mining ────────────────────────────────────────────────────

function extractCwdFromJsonl(filePath: string): string | null {
  try {
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
      } catch { continue; }
    }
  } catch {}
  return null;
}

function extractCwdFromCodexJsonl(filePath: string): string | null {
  try {
    const fd = openSync(filePath, "r");
    const buf = Buffer.alloc(4096);
    const bytesRead = readSync(fd, buf, 0, 4096, 0);
    closeSync(fd);
    const firstLine = buf.toString("utf-8", 0, bytesRead).split("\n")[0];
    if (!firstLine) return null;
    const meta = JSON.parse(firstLine);
    if (meta.type === "session_meta" && meta.payload?.cwd) return meta.payload.cwd;
  } catch {}
  return null;
}

export function discoverClaudeSessions(repoPath: string, since: Date): ConversationSession[] {
  const projectsDir = join(homedir(), ".claude", "projects");
  if (!existsSync(projectsDir)) return [];

  const sessions: ConversationSession[] = [];
  const resolvedRepo = resolve(repoPath);

  try {
    for (const dirEntry of readdirSync(projectsDir, { withFileTypes: true })) {
      if (!dirEntry.isDirectory()) continue;
      const dirPath = join(projectsDir, dirEntry.name);

      // Check mtime — skip dirs not modified in 30 days
      try {
        if (statSync(dirPath).mtime < since) continue;
      } catch { continue; }

      // Try to match by decoded directory name
      const decoded = dirEntry.name.replace(/-/g, "/");
      const isMatch = decoded === resolvedRepo || decoded.endsWith(resolvedRepo) ||
        resolvedRepo.includes(dirEntry.name.replace(/-/g, "/").replace(/^\//, ""));

      if (!isMatch) {
        // Fallback: check JSONL for cwd
        const files = readdirSync(dirPath).filter(f => f.endsWith(".jsonl"));
        if (files.length === 0) continue;
        const cwd = extractCwdFromJsonl(join(dirPath, files[0]));
        if (!cwd || resolve(cwd) !== resolvedRepo) continue;
      }

      // Found matching project dir — list JSONL files
      const jsonlFiles = readdirSync(dirPath)
        .filter(f => f.endsWith(".jsonl"))
        .map(f => ({ name: f, mtime: statSync(join(dirPath, f)).mtime }))
        .filter(f => f.mtime >= since)
        .sort((a, b) => b.mtime.getTime() - a.mtime.getTime())
        .slice(0, 20);

      for (const f of jsonlFiles) {
        sessions.push({
          tool: "claude_code",
          filePath: join(dirPath, f.name),
          cwd: resolvedRepo,
          mtime: f.mtime,
        });
      }
    }
  } catch {}
  return sessions;
}

export function discoverCodexSessions(repoPath: string, since: Date): ConversationSession[] {
  const sessionsDir = join(homedir(), ".codex", "sessions");
  if (!existsSync(sessionsDir)) return [];

  const sessions: ConversationSession[] = [];
  const resolvedRepo = resolve(repoPath);

  try {
    const years = readdirSync(sessionsDir);
    for (const year of years) {
      const yearPath = join(sessionsDir, year);
      if (!statSync(yearPath).isDirectory()) continue;
      for (const month of readdirSync(yearPath)) {
        const monthPath = join(yearPath, month);
        if (!statSync(monthPath).isDirectory()) continue;
        for (const day of readdirSync(monthPath)) {
          const dayPath = join(monthPath, day);
          if (!statSync(dayPath).isDirectory()) continue;
          const files = readdirSync(dayPath).filter(f => f.startsWith("rollout-") && f.endsWith(".jsonl"));
          for (const file of files) {
            const filePath = join(dayPath, file);
            try {
              const stat = statSync(filePath);
              if (stat.mtime < since) continue;
              const cwd = extractCwdFromCodexJsonl(filePath);
              if (cwd && resolve(cwd) === resolvedRepo) {
                sessions.push({ tool: "codex", filePath, cwd: resolvedRepo, mtime: stat.mtime });
              }
            } catch { continue; }
          }
        }
      }
    }
  } catch {}

  return sessions.sort((a, b) => b.mtime.getTime() - a.mtime.getTime()).slice(0, 20);
}

export function discoverGeminiSessions(repoPath: string, since: Date): ConversationSession[] {
  const tmpDir = join(homedir(), ".gemini", "tmp");
  if (!existsSync(tmpDir)) return [];

  const sessions: ConversationSession[] = [];
  const resolvedRepo = resolve(repoPath);

  // Load projects.json
  let projectsMap: Record<string, string> = {};
  const projectsPath = join(homedir(), ".gemini", "projects.json");
  if (existsSync(projectsPath)) {
    try {
      const data = JSON.parse(readFileSync(projectsPath, { encoding: "utf-8" }));
      const projects = data.projects || {};
      for (const [path, name] of Object.entries(projects)) {
        projectsMap[name as string] = path;
      }
    } catch {}
  }

  try {
    for (const projectName of readdirSync(tmpDir)) {
      const chatsDir = join(tmpDir, projectName, "chats");
      if (!existsSync(chatsDir)) continue;

      let cwd = projectsMap[projectName] || null;
      if (!cwd) {
        const rootFile = join(tmpDir, projectName, ".project_root");
        if (existsSync(rootFile)) {
          try { cwd = readFileSync(rootFile, { encoding: "utf-8" }).trim(); } catch {}
        }
      }
      if (!cwd || resolve(cwd) !== resolvedRepo) continue;

      const files = readdirSync(chatsDir)
        .filter(f => f.startsWith("session-") && f.endsWith(".json"))
        .map(f => ({ name: f, mtime: statSync(join(chatsDir, f)).mtime }))
        .filter(f => f.mtime >= since)
        .sort((a, b) => b.mtime.getTime() - a.mtime.getTime())
        .slice(0, 20);

      for (const f of files) {
        sessions.push({ tool: "gemini", filePath: join(chatsDir, f.name), cwd: resolvedRepo, mtime: f.mtime });
      }
    }
  } catch {}

  return sessions;
}

export function extractPatterns(sessions: ConversationSession[]): ExtractedPatterns {
  const patterns: ExtractedPatterns = {
    referencedFiles: new Map(),
    errors: new Map(),
    topics: new Map(),
    workflows: new Map(),
    sessionsAnalyzed: 0,
    sessionsSkipped: 0,
    byTool: { claude_code: 0, codex: 0, gemini: 0 },
  };

  for (const session of sessions) {
    try {
      const stat = statSync(session.filePath);
      const maxRead = stat.size > 50 * 1024 * 1024 ? 100 * 1024 : Math.min(stat.size, 5 * 1024 * 1024);
      // Read only maxRead bytes to avoid loading huge files into memory
      const fd = openSync(session.filePath, "r");
      const buf = Buffer.alloc(maxRead);
      const bytesRead = readSync(fd, buf, 0, maxRead, 0);
      closeSync(fd);
      const content = buf.toString("utf-8", 0, bytesRead);

      // Extract file references (paths that look like source files)
      const fileRefs = content.match(/(?:["']|\/)([\w.-]+\/[\w.-]+\.(?:ts|js|py|rb|go|rs|md|yaml|json))/g) || [];
      for (const ref of fileRefs) {
        const clean = ref.replace(/^["'/]/, "");
        patterns.referencedFiles.set(clean, (patterns.referencedFiles.get(clean) || 0) + 1);
      }

      // Extract error patterns
      const errorPatterns = content.match(/(?:Error|error|FAIL|FAILED|Exception|TypeError|SyntaxError)[:\s].{10,80}/g) || [];
      for (const err of errorPatterns) {
        const normalized = err.trim().slice(0, 80);
        patterns.errors.set(normalized, (patterns.errors.get(normalized) || 0) + 1);
      }

      // Extract workflow patterns (skill invocations)
      const skillRefs = content.match(/\/(?:qa|review|ship|cso|investigate|meditate|retro|office-hours|plan-eng-review|plan-ceo-review|design-review)\b/g) || [];
      for (const skill of skillRefs) {
        patterns.workflows.set(skill, (patterns.workflows.get(skill) || 0) + 1);
      }

      // Extract topic clusters by directory
      const dirRefs = content.match(/(?:["']|\/)([\w.-]+)\//g) || [];
      for (const dir of dirRefs) {
        const clean = dir.replace(/^["'/]/, "").replace(/\/$/, "");
        if (clean.length > 1 && clean.length < 30 && !clean.startsWith(".")) {
          patterns.topics.set(clean, (patterns.topics.get(clean) || 0) + 1);
        }
      }

      patterns.sessionsAnalyzed++;
      patterns.byTool[session.tool]++;
    } catch {
      patterns.sessionsSkipped++;
    }
  }

  return patterns;
}

function topEntries(map: Map<string, number>, threshold: number, limit: number): string[] {
  return [...map.entries()]
    .filter(([, count]) => count >= threshold)
    .sort(([, a], [, b]) => b - a)
    .slice(0, limit)
    .map(([key]) => key);
}

// ── Template synthesis ─────────────────────────────────────────────────────

export function templateSynthesize(snapshot: RepoSnapshot): string {
  const lines: string[] = [];
  const { repo, activity, conversations, docs } = snapshot;

  lines.push(`# Repo Consciousness — ${repo.slug}`);
  lines.push(`Last meditation: ${snapshot.timestamp} (auto-scan, run /meditate for deeper analysis)`);
  lines.push("");

  // Architecture Map
  lines.push("## Architecture Map");
  lines.push(`Languages: ${repo.languages.join(", ")}. Framework: ${repo.framework}. ${repo.file_count} files.`);
  const topDirs = Object.keys(repo.structure).filter(d => d === ".").length > 0
    ? (repo.structure["."] || []).filter((e: string) => e.endsWith("/")).map((e: string) => e.replace("/", "")).slice(0, 10)
    : Object.keys(repo.structure).slice(0, 10);
  lines.push(`Key directories: ${topDirs.join(", ")}`);
  if (docs.claude_md) {
    lines.push("");
    lines.push("From CLAUDE.md:");
    lines.push(docs.claude_md.split("\n").slice(0, 15).join("\n"));
  }
  lines.push("");

  // Hotspots
  lines.push("## Hotspots");
  if (activity.hotspots.length > 0) {
    for (const f of activity.hotspots.slice(0, 10)) {
      lines.push(`- ${f}`);
    }
  } else {
    lines.push("No recent activity detected.");
  }
  lines.push("");

  // Conventions
  lines.push("## Conventions");
  if (docs.claude_md) {
    lines.push("Extracted from CLAUDE.md — see project instructions for full details.");
  } else {
    lines.push("Run /meditate for convention analysis.");
  }
  lines.push("");

  // User Taste
  lines.push("## User Taste");
  if (conversations.workflow_patterns.length > 0) {
    lines.push("Based on conversation mining:");
    for (const p of conversations.workflow_patterns) {
      lines.push(`- ${p}`);
    }
  } else {
    lines.push("Run /meditate for taste analysis (needs AI session history).");
  }
  lines.push("");

  // Recurring Problems
  lines.push("## Recurring Problems");
  if (conversations.recurring_errors.length > 0) {
    for (const e of conversations.recurring_errors) {
      lines.push(`- ${e}`);
    }
  } else {
    lines.push("No recurring patterns detected yet.");
  }
  lines.push("");

  // Watch These Next
  lines.push("## Watch These Next");
  if (activity.todos.length > 0) {
    lines.push("### TODOs");
    for (const t of activity.todos.slice(0, 15)) {
      lines.push(`- ${t.file}:${t.line}: ${t.text}`);
    }
  }

  // Untested hotspots
  const untestedHotspots = activity.hotspots.filter(f => f.endsWith(".ts") || f.endsWith(".py") || f.endsWith(".js"))
    .filter(f => !repo.test_coverage_map[f]);
  if (untestedHotspots.length > 0) {
    lines.push("### Untested hotspots (high churn, no test file)");
    for (const f of untestedHotspots.slice(0, 5)) {
      lines.push(`- ${f}`);
    }
  }
  lines.push("");

  // Enforce 1024-line limit
  if (lines.length > 1024) {
    return lines.slice(0, 1020).join("\n") + "\n\n<!-- truncated to 1024 lines -->\n";
  }
  return lines.join("\n");
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { repo, output, background } = parseArgs();
  const startTime = Date.now();

  if (!existsSync(repo)) {
    console.error(`Error: repo path does not exist: ${repo}`);
    process.exit(1);
  }

  const slug = deriveSlug(repo);
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  // Count files
  let fileCount = 0;
  try {
    const out = execSync('git ls-files 2>/dev/null | wc -l', {
      cwd: repo, timeout: 5000, stdio: ["pipe", "pipe", "pipe"],
    }).toString().trim();
    fileCount = parseInt(out, 10) || 0;
  } catch {}

  // Parallel scanning
  const [repoData, convData] = await Promise.all([
    (async () => {
      const structure = scanRepoStructure(repo);
      const { languages, framework } = detectLanguages(repo);
      const activity = scanGitActivity(repo);
      const todos = scanTodos(repo);
      const testMap = mapTestCoverage(repo);
      const docs = extractDocs(repo);
      return { structure, languages, framework, activity, todos, testMap, docs };
    })(),
    (async () => {
      const claudeSessions = discoverClaudeSessions(repo, since);
      const codexSessions = discoverCodexSessions(repo, since);
      const geminiSessions = discoverGeminiSessions(repo, since);
      const allSessions = [...claudeSessions, ...codexSessions, ...geminiSessions]
        .sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
      return extractPatterns(allSessions);
    })(),
  ]);

  const duration = Date.now() - startTime;
  const partial = duration > 15000;

  const snapshot: RepoSnapshot = {
    version: 1,
    timestamp: new Date().toISOString(),
    duration_ms: duration,
    repo: {
      slug,
      remote: (() => { try { return execSync("git remote get-url origin", { cwd: repo, stdio: ["pipe", "pipe", "pipe"], timeout: 3000 }).toString().trim(); } catch { return ""; } })(),
      languages: repoData.languages,
      framework: repoData.framework,
      structure: repoData.structure,
      file_count: fileCount,
      test_coverage_map: repoData.testMap,
    },
    activity: {
      ...repoData.activity,
      todos: repoData.todos,
    },
    conversations: {
      sessions_analyzed: convData.sessionsAnalyzed,
      sessions_skipped: convData.sessionsSkipped,
      by_tool: convData.byTool,
      most_referenced_files: topEntries(convData.referencedFiles, 3, 15),
      recurring_errors: topEntries(convData.errors, 3, 10),
      recurring_topics: topEntries(convData.topics, 5, 10),
      workflow_patterns: topEntries(convData.workflows, 1, 10),
    },
    docs: repoData.docs,
    partial,
  };

  // Determine output path
  const outputDir = join(homedir(), ".gstack", "meditations", slug);
  mkdirSync(outputDir, { recursive: true });
  const outputPath = output || join(outputDir, `${new Date().toISOString().slice(0, 10)}.json`);

  // Atomic write: temp → rename
  const tmpPath = join(tmpdir(), `gstack-meditate-${Date.now()}.json`);
  writeFileSync(tmpPath, JSON.stringify(snapshot, null, 2));
  renameSync(tmpPath, outputPath);

  // Prune old snapshots (keep last 30)
  try {
    const existing = readdirSync(outputDir)
      .filter(f => f.endsWith(".json"))
      .sort()
      .reverse();
    for (const old of existing.slice(30)) {
      try { unlinkSync(join(outputDir, old)); } catch {}
    }
  } catch {}

  console.log(JSON.stringify({
    status: "ok",
    slug,
    snapshot_path: outputPath,
    duration_ms: duration,
    sessions: {
      claude_code: convData.byTool.claude_code,
      codex: convData.byTool.codex,
      gemini: convData.byTool.gemini,
    },
    partial,
  }));

  // Background mode: also produce template-based context.md
  if (background) {
    const contextContent = templateSynthesize(snapshot);
    const contextDir = join(repo, ".gstack");
    let contextPath: string;
    try {
      mkdirSync(contextDir, { recursive: true });
      contextPath = join(contextDir, "context.md");
    } catch {
      // Fallback to user-local
      const fallbackDir = join(homedir(), ".gstack", "projects", slug);
      mkdirSync(fallbackDir, { recursive: true });
      contextPath = join(fallbackDir, "context.md");
      console.error(`Warning: no write access to ${contextDir}, using ${contextPath}`);
    }
    const tmpCtx = join(tmpdir(), `gstack-context-${Date.now()}.md`);
    writeFileSync(tmpCtx, contextContent);
    renameSync(tmpCtx, contextPath);
  }
}

main().catch(err => {
  console.error("gstack-meditate failed:", err.message);
  process.exit(1);
});
