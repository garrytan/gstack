#!/usr/bin/env bun
/**
 * /metrics — Real-Time Sprint Dashboard for gstack
 * -------------------------------------------------
 * A live terminal dashboard that shows health across all parallel
 * Claude Code sprints. Run with: bun run metrics/index.ts
 *
 * What it tracks:
 *   - Lines added/deleted today and this week (per branch)
 *   - Test coverage % and trend
 *   - Which gstack skills have been run per branch
 *   - Active branches with last activity time
 *   - Sprint completion % (plan → build → review → qa → ship)
 *
 * Usage:
 *   bun run metrics/index.ts          # snapshot mode (one-time print)
 *   bun run metrics/index.ts --watch  # live refresh every 5s
 *   bun run metrics/index.ts --json   # JSON output for scripting
 */

import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// ─────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────

interface BranchStats {
  name: string;
  linesAdded: number;
  linesDeleted: number;
  commits: number;
  lastActivity: string; // relative time string
  lastActivityTs: number; // unix ms
  skillsRun: string[];
  sprintCompletion: number; // 0–100
  testCoverage: number | null; // null = not detected
  testsPassing: boolean | null;
}

interface DailyStats {
  totalLinesAdded: number;
  totalLinesDeleted: number;
  totalCommits: number;
  activeBranches: number;
  weeklyLinesAdded: number;
  avgDailyLinesThisWeek: number;
}

interface MetricsReport {
  generatedAt: string;
  repoName: string;
  currentBranch: string;
  daily: DailyStats;
  branches: BranchStats[];
}

// ─────────────────────────────────────────────
// ANSI COLORS
// ─────────────────────────────────────────────

const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  cyan: "\x1b[36m",
  magenta: "\x1b[35m",
  blue: "\x1b[34m",
  white: "\x1b[37m",
  bgDark: "\x1b[40m",
  gray: "\x1b[90m",
};

// ─────────────────────────────────────────────
// GIT HELPERS
// ─────────────────────────────────────────────

function run(cmd: string, fallback = ""): string {
  try {
    return execSync(cmd, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
  } catch {
    return fallback;
  }
}

function getRepoRoot(): string {
  return run("git rev-parse --show-toplevel", process.cwd());
}

function getRepoName(root: string): string {
  return path.basename(root);
}

function getCurrentBranch(): string {
  return run("git rev-parse --abbrev-ref HEAD", "unknown");
}

function getAllBranches(): string[] {
  const raw = run("git branch --format=%(refname:short)");
  return raw.split("\n").filter(Boolean);
}

/**
 * Lines added/deleted for a branch since N hours ago
 */
function getBranchLineStats(
  branch: string,
  sinceHours = 24
): { added: number; deleted: number; commits: number } {
  const since = new Date(Date.now() - sinceHours * 3600 * 1000).toISOString();
  const log = run(
    `git log ${branch} --since="${since}" --numstat --format="" 2>/dev/null`
  );

  let added = 0;
  let deleted = 0;
  for (const line of log.split("\n")) {
    const parts = line.trim().split(/\s+/);
    if (parts.length >= 2 && /^\d+$/.test(parts[0]) && /^\d+$/.test(parts[1])) {
      added += parseInt(parts[0]);
      deleted += parseInt(parts[1]);
    }
  }

  const commits = parseInt(
    run(`git log ${branch} --since="${since}" --oneline | wc -l`, "0"),
    10
  );

  return { added, deleted, commits };
}

function getWeeklyLineStats(): { added: number; commits: number } {
  const since = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
  const log = run(`git log --all --since="${since}" --numstat --format="" 2>/dev/null`);

  let added = 0;
  for (const line of log.split("\n")) {
    const parts = line.trim().split(/\s+/);
    if (parts.length >= 2 && /^\d+$/.test(parts[0])) {
      added += parseInt(parts[0]);
    }
  }

  const commits = parseInt(
    run(`git log --all --since="${since}" --oneline | wc -l`, "0"),
    10
  );

  return { added, commits };
}

function getLastActivityTime(branch: string): { display: string; ts: number } {
  const raw = run(`git log ${branch} -1 --format="%ar|%at" 2>/dev/null`);
  if (!raw) return { display: "never", ts: 0 };
  const [display, tsStr] = raw.split("|");
  return { display: display ?? "unknown", ts: parseInt(tsStr ?? "0") * 1000 };
}

// ─────────────────────────────────────────────
// GSTACK SESSION STATE
// ─────────────────────────────────────────────

const GSTACK_SKILLS = [
  "office-hours",
  "plan-ceo-review",
  "plan-eng-review",
  "plan-design-review",
  "review",
  "qa",
  "ship",
];

/**
 * Try to read .gstack/session.json if it exists (written by gstack itself).
 * Falls back to scanning commit messages for skill invocations.
 */
function detectSkillsRun(branch: string): string[] {
  // 1. Try session file
  const sessionFile = path.join(getRepoRoot(), ".gstack", "session.json");
  if (fs.existsSync(sessionFile)) {
    try {
      const data = JSON.parse(fs.readFileSync(sessionFile, "utf8"));
      const branchData = data?.branches?.[branch];
      if (Array.isArray(branchData?.skillsRun)) {
        return branchData.skillsRun;
      }
    } catch {
      // fall through
    }
  }

  // 2. Scan recent commit messages for skill markers
  const messages = run(
    `git log ${branch} --since="7 days ago" --format="%s" 2>/dev/null`
  );
  const found = new Set<string>();
  for (const skill of GSTACK_SKILLS) {
    if (messages.toLowerCase().includes(skill.replace("-", " ")) ||
        messages.toLowerCase().includes(`/${skill}`)) {
      found.add(skill);
    }
  }

  // 3. Infer from branch name conventions
  const lower = branch.toLowerCase();
  if (lower.includes("plan")) found.add("plan-eng-review");
  if (lower.includes("qa")) found.add("qa");
  if (lower.includes("ship") || lower.includes("release")) found.add("ship");
  if (lower.includes("review")) found.add("review");

  return Array.from(found);
}

function calcSprintCompletion(skillsRun: string[]): number {
  const pipeline = ["office-hours", "plan-eng-review", "review", "qa", "ship"];
  const done = pipeline.filter((s) => skillsRun.includes(s)).length;
  return Math.round((done / pipeline.length) * 100);
}

// ─────────────────────────────────────────────
// TEST COVERAGE DETECTION
// ─────────────────────────────────────────────

function detectTestCoverage(root: string): { coverage: number | null; passing: boolean | null } {
  // Look for common coverage output files
  const coverageFiles = [
    path.join(root, "coverage", "coverage-summary.json"),
    path.join(root, "coverage.json"),
    path.join(root, ".nyc_output", "coverage-summary.json"),
  ];

  for (const f of coverageFiles) {
    if (fs.existsSync(f)) {
      try {
        const data = JSON.parse(fs.readFileSync(f, "utf8"));
        const total = data?.total?.lines?.pct ?? data?.total?.statements?.pct;
        if (typeof total === "number") {
          return { coverage: Math.round(total), passing: total > 0 };
        }
      } catch {
        // continue
      }
    }
  }

  // Check for jest/vitest summary in common output dirs
  const jestReport = path.join(root, "test-results.json");
  if (fs.existsSync(jestReport)) {
    try {
      const data = JSON.parse(fs.readFileSync(jestReport, "utf8"));
      const passing = data?.numFailedTests === 0;
      return { coverage: null, passing };
    } catch {
      // continue
    }
  }

  return { coverage: null, passing: null };
}

// ─────────────────────────────────────────────
// RENDER
// ─────────────────────────────────────────────

function bar(pct: number, width = 20): string {
  const filled = Math.round((pct / 100) * width);
  const empty = width - filled;
  const color = pct >= 80 ? C.green : pct >= 50 ? C.yellow : C.red;
  return color + "█".repeat(filled) + C.gray + "░".repeat(empty) + C.reset;
}

function coverageBadge(pct: number | null): string {
  if (pct === null) return C.dim + "  n/a  " + C.reset;
  const color = pct >= 80 ? C.green : pct >= 50 ? C.yellow : C.red;
  return color + `${pct.toString().padStart(3)}%` + C.reset;
}

function skillBadges(skills: string[]): string {
  const all = GSTACK_SKILLS;
  return all
    .map((s) => {
      const short = s.split("-").map((w) => w[0]).join("").toUpperCase();
      return skills.includes(s)
        ? C.green + `[${short}]` + C.reset
        : C.gray + `[${short}]` + C.reset;
    })
    .join(" ");
}

function renderDashboard(report: MetricsReport): void {
  const { daily, branches, repoName, currentBranch, generatedAt } = report;

  console.clear();

  // ── Header ──
  console.log(
    C.bold + C.cyan +
    "╔══════════════════════════════════════════════════════════════╗" +
    C.reset
  );
  console.log(
    C.bold + C.cyan + "║" + C.reset +
    C.bold + `  ⚡ gstack /metrics  —  ${repoName}`.padEnd(62) + C.reset +
    C.bold + C.cyan + "║" + C.reset
  );
  console.log(
    C.bold + C.cyan + "║" + C.reset +
    C.dim + `  ${generatedAt}`.padEnd(62) + C.reset +
    C.bold + C.cyan + "║" + C.reset
  );
  console.log(
    C.bold + C.cyan +
    "╚══════════════════════════════════════════════════════════════╝" +
    C.reset
  );
  console.log();

  // ── Daily Summary ──
  console.log(C.bold + "  TODAY  " + C.reset + C.dim + "────────────────────────────────────────" + C.reset);
  console.log(
    `  ${C.green}+${daily.totalLinesAdded.toLocaleString()}${C.reset} lines  ` +
    `${C.red}-${daily.totalLinesDeleted.toLocaleString()}${C.reset} lines  ` +
    `${C.yellow}${daily.totalCommits} commits${C.reset}  ` +
    `${C.cyan}${daily.activeBranches} active branches${C.reset}`
  );
  console.log(
    `  Weekly: ${C.bold}${daily.weeklyLinesAdded.toLocaleString()}${C.reset} lines added  ` +
    `(avg ${C.bold}${daily.avgDailyLinesThisWeek.toLocaleString()}${C.reset}/day)`
  );
  console.log();

  // ── Branch Table ──
  console.log(C.bold + "  BRANCHES  " + C.reset + C.dim + "──────────────────────────────────────" + C.reset);
  console.log(
    C.dim +
    "  Branch".padEnd(28) +
    "+Lines".padEnd(9) +
    "Commits".padEnd(9) +
    "Coverage".padEnd(10) +
    "Sprint".padEnd(8) +
    "Last Active" +
    C.reset
  );
  console.log(C.dim + "  " + "─".repeat(76) + C.reset);

  const sorted = [...branches].sort((a, b) => b.lastActivityTs - a.lastActivityTs);

  for (const b of sorted) {
    const isCurrent = b.name === currentBranch;
    const nameStr = (isCurrent ? "* " : "  ") + b.name;
    const nameColor = isCurrent ? C.bold + C.cyan : "";

    console.log(
      nameColor + nameStr.padEnd(28) + C.reset +
      C.green + `+${b.linesAdded.toLocaleString()}`.padEnd(9) + C.reset +
      C.yellow + String(b.commits).padEnd(9) + C.reset +
      coverageBadge(b.testCoverage).padEnd(10) +
      `${bar(b.sprintCompletion, 8)} ${b.sprintCompletion}%`.padEnd(22) +
      C.dim + b.lastActivity + C.reset
    );

    // Skill badges on second line
    console.log(
      "  " + C.dim + "Skills: " + C.reset + skillBadges(b.skillsRun)
    );
    console.log();
  }

  // ── Legend ──
  console.log(C.dim + "  Skill badges: " + C.reset +
    "[OH]=office-hours  [PC]=plan-ceo  [PE]=plan-eng  [PD]=plan-design  " +
    "[R]=review  [Q]=qa  [S]=ship"
  );
  console.log();
  console.log(C.dim + "  Sprint % = pipeline steps completed: office-hours → plan-eng → review → qa → ship" + C.reset);
  console.log();
}

function renderJSON(report: MetricsReport): void {
  console.log(JSON.stringify(report, null, 2));
}

// ─────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────

async function collectMetrics(): Promise<MetricsReport> {
  const root = getRepoRoot();
  const repoName = getRepoName(root);
  const currentBranch = getCurrentBranch();
  const branches = getAllBranches();

  const branchStats: BranchStats[] = [];

  for (const branch of branches) {
    const { added, deleted, commits } = getBranchLineStats(branch, 24);
    const { display: lastActivity, ts: lastActivityTs } = getLastActivityTime(branch);
    const skillsRun = detectSkillsRun(branch);
    const sprintCompletion = calcSprintCompletion(skillsRun);
    const { coverage, passing } = detectTestCoverage(root);

    branchStats.push({
      name: branch,
      linesAdded: added,
      linesDeleted: deleted,
      commits,
      lastActivity,
      lastActivityTs,
      skillsRun,
      sprintCompletion,
      testCoverage: coverage,
      testsPassing: passing,
    });
  }

  const weekly = getWeeklyLineStats();
  const totalLinesAdded = branchStats.reduce((s, b) => s + b.linesAdded, 0);
  const totalLinesDeleted = branchStats.reduce((s, b) => s + b.linesDeleted, 0);
  const totalCommits = branchStats.reduce((s, b) => s + b.commits, 0);
  const activeBranches = branchStats.filter((b) => b.commits > 0 || b.linesAdded > 0).length;

  return {
    generatedAt: new Date().toLocaleString(),
    repoName,
    currentBranch,
    daily: {
      totalLinesAdded,
      totalLinesDeleted,
      totalCommits,
      activeBranches,
      weeklyLinesAdded: weekly.added,
      avgDailyLinesThisWeek: Math.round(weekly.added / 7),
    },
    branches: branchStats,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const watchMode = args.includes("--watch");
  const jsonMode = args.includes("--json");

  if (watchMode) {
    while (true) {
      const report = await collectMetrics();
      jsonMode ? renderJSON(report) : renderDashboard(report);
      await new Promise((r) => setTimeout(r, 5000));
    }
  } else {
    const report = await collectMetrics();
    jsonMode ? renderJSON(report) : renderDashboard(report);
  }
}

main().catch((e) => {
  console.error("metrics error:", e);
  process.exit(1);
});
