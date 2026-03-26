/**
 * gstack Dashboard — Data Access Layer
 *
 * Reads all gstack data sources:
 *   - .gstack/browse.json          → daemon status
 *   - .gstack/qa-reports/*.json    → QA reports
 *   - .gstack/benchmark-reports/*.json → benchmark data
 *   - .gstack/canary-reports/*.json    → canary monitoring
 *   - .gstack/design-reports/*.json    → design reviews
 *   - ~/.gstack/analytics/skill-usage.jsonl → skill usage telemetry
 *   - ~/.gstack/analytics/eureka.jsonl      → eureka moments
 *   - .gstack/browse-console.log   → browser console logs
 *   - .gstack/browse-network.log   → browser network logs
 *   - .gstack/browse-dialog.log    → browser dialog logs
 */

import * as fs from 'fs';
import * as path from 'path';

// ─── Types ──────────────────────────────────────────────────────

export interface DaemonStatus {
  pid: number;
  port: number;
  token: string;
  startedAt: string;
  binaryVersion?: string;
  alive: boolean;
  uptime?: number;
}

export interface QAReport {
  filename: string;
  date: string;
  data: Record<string, any>;
}

export interface BenchmarkReport {
  filename: string;
  date: string;
  data: Record<string, any>;
}

export interface CanaryReport {
  filename: string;
  date: string;
  data: Record<string, any>;
}

export interface DesignReport {
  filename: string;
  date: string;
  data: Record<string, any>;
}

export interface SkillUsageEntry {
  event_type?: string;
  skill: string;
  ts: string;
  repo?: string;
  duration_s?: number;
  outcome?: string;
  used_browse?: boolean;
  concurrent_sessions?: number;
}

export interface EurekaEntry {
  ts: string;
  skill: string;
  branch?: string;
  insight: string;
}

export interface LogEntry {
  timestamp: string;
  level?: string;
  text?: string;
  method?: string;
  url?: string;
  status?: number;
  duration?: number;
  size?: number;
  type?: string;
  message?: string;
}

export interface SkillStats {
  name: string;
  runs: number;
  avgDuration: number;
  successRate: number;
  errors: number;
  lastRun?: string;
  usedBrowse: number;
}

export interface PipelineStage {
  id: string;
  name: string;
  icon: string;
  skills: string[];
  status: 'idle' | 'active' | 'completed';
  lastRun?: string;
  reportCount: number;
}

// ─── Config Resolution ──────────────────────────────────────────

function getGitRoot(): string | null {
  try {
    const proc = Bun.spawnSync(['git', 'rev-parse', '--show-toplevel'], {
      stdout: 'pipe', stderr: 'pipe', timeout: 2_000,
    });
    if (proc.exitCode !== 0) return null;
    return proc.stdout.toString().trim() || null;
  } catch { return null; }
}

function getGstackDir(): string {
  const root = getGitRoot() || process.cwd();
  return path.join(root, '.gstack');
}

function getGlobalGstackDir(): string {
  return path.join(process.env.HOME || '~', '.gstack');
}

function getProjectRoot(): string {
  return getGitRoot() || process.cwd();
}

// ─── File Helpers ───────────────────────────────────────────────

function readJsonSafe(filePath: string): any | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch { return null; }
}

function readJsonlSafe(filePath: string, maxLines = 10000): any[] {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.trim().split('\n').slice(-maxLines);
    return lines
      .filter(l => l.trim())
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

function listJsonFiles(dir: string): string[] {
  try {
    return fs.readdirSync(dir)
      .filter(f => f.endsWith('.json'))
      .sort()
      .reverse(); // newest first
  } catch { return []; }
}

function readLogFile(filePath: string, tailLines = 200): string[] {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    return content.trim().split('\n').slice(-tailLines);
  } catch { return []; }
}

function parseLogLines(lines: string[]): LogEntry[] {
  return lines.map(line => {
    try { return JSON.parse(line); } catch {
      // Fallback: treat as plain text log
      const match = line.match(/^\[(.+?)\]\s*(.+)/);
      if (match) return { timestamp: match[1], text: match[2] };
      return { timestamp: new Date().toISOString(), text: line };
    }
  });
}

// ─── Data Access Functions ──────────────────────────────────────

export function getDaemonStatus(): DaemonStatus | null {
  const stateFile = path.join(getGstackDir(), 'browse.json');
  const data = readJsonSafe(stateFile);
  if (!data) return null;

  let alive = false;
  if (data.pid) {
    try { process.kill(data.pid, 0); alive = true; } catch { alive = false; }
  }

  const uptime = data.startedAt
    ? Math.floor((Date.now() - new Date(data.startedAt).getTime()) / 1000)
    : undefined;

  return { ...data, alive, uptime };
}

export function getQAReports(): QAReport[] {
  const dir = path.join(getGstackDir(), 'qa-reports');
  return listJsonFiles(dir).map(f => ({
    filename: f,
    date: extractDateFromFilename(f),
    data: readJsonSafe(path.join(dir, f)) || {},
  }));
}

export function getBenchmarkReports(): BenchmarkReport[] {
  const dir = path.join(getGstackDir(), 'benchmark-reports');
  return listJsonFiles(dir).map(f => ({
    filename: f,
    date: extractDateFromFilename(f),
    data: readJsonSafe(path.join(dir, f)) || {},
  }));
}

export function getCanaryReports(): CanaryReport[] {
  const dir = path.join(getGstackDir(), 'canary-reports');
  return listJsonFiles(dir).map(f => ({
    filename: f,
    date: extractDateFromFilename(f),
    data: readJsonSafe(path.join(dir, f)) || {},
  }));
}

export function getDesignReports(): DesignReport[] {
  const dir = path.join(getGstackDir(), 'design-reports');
  return listJsonFiles(dir).map(f => ({
    filename: f,
    date: extractDateFromFilename(f),
    data: readJsonSafe(path.join(dir, f)) || {},
  }));
}

export function getSkillUsage(daysBack = 30): SkillUsageEntry[] {
  const globalDir = getGlobalGstackDir();
  const filePath = path.join(globalDir, 'analytics', 'skill-usage.jsonl');
  const entries = readJsonlSafe(filePath) as SkillUsageEntry[];

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - daysBack);
  const cutoffStr = cutoff.toISOString();

  return entries.filter(e => {
    if (e.event_type === 'hook_fire') return false;
    if (e.event_type && e.event_type !== 'skill_run') return false;
    if (e.ts && e.ts < cutoffStr) return false;
    return true;
  });
}

export function getSkillStats(daysBack = 30): SkillStats[] {
  const entries = getSkillUsage(daysBack);
  const map = new Map<string, {
    runs: number; totalDuration: number; successes: number;
    errors: number; lastRun: string; usedBrowse: number;
  }>();

  for (const e of entries) {
    const name = e.skill || 'unknown';
    const stat = map.get(name) || {
      runs: 0, totalDuration: 0, successes: 0, errors: 0, lastRun: '', usedBrowse: 0,
    };
    stat.runs++;
    if (e.duration_s) stat.totalDuration += e.duration_s;
    if (e.outcome === 'success') stat.successes++;
    if (e.outcome === 'error') stat.errors++;
    if (e.ts && e.ts > stat.lastRun) stat.lastRun = e.ts;
    if (e.used_browse) stat.usedBrowse++;
    map.set(name, stat);
  }

  return Array.from(map.entries())
    .map(([name, s]) => ({
      name,
      runs: s.runs,
      avgDuration: s.runs > 0 ? Math.round(s.totalDuration / s.runs) : 0,
      successRate: s.runs > 0 ? Math.round((s.successes / s.runs) * 100) : 0,
      errors: s.errors,
      lastRun: s.lastRun || undefined,
      usedBrowse: s.usedBrowse,
    }))
    .sort((a, b) => b.runs - a.runs);
}

export function getEurekaMoments(daysBack = 90): EurekaEntry[] {
  const globalDir = getGlobalGstackDir();
  const filePath = path.join(globalDir, 'analytics', 'eureka.jsonl');
  const entries = readJsonlSafe(filePath) as EurekaEntry[];

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - daysBack);
  const cutoffStr = cutoff.toISOString();

  return entries
    .filter(e => !e.ts || e.ts >= cutoffStr)
    .sort((a, b) => (b.ts || '').localeCompare(a.ts || ''));
}

export function getConsoleLogs(tailLines = 200): LogEntry[] {
  const logFile = path.join(getGstackDir(), 'browse-console.log');
  return parseLogLines(readLogFile(logFile, tailLines));
}

export function getNetworkLogs(tailLines = 200): LogEntry[] {
  const logFile = path.join(getGstackDir(), 'browse-network.log');
  return parseLogLines(readLogFile(logFile, tailLines));
}

export function getDialogLogs(tailLines = 100): LogEntry[] {
  const logFile = path.join(getGstackDir(), 'browse-dialog.log');
  return parseLogLines(readLogFile(logFile, tailLines));
}

export function getPipelineStages(): PipelineStage[] {
  const usage = getSkillUsage(7); // last week
  const skillLastRun = new Map<string, string>();
  for (const e of usage) {
    if (e.skill && e.ts) {
      const prev = skillLastRun.get(e.skill);
      if (!prev || e.ts > prev) skillLastRun.set(e.skill, e.ts);
    }
  }

  const stages: PipelineStage[] = [
    {
      id: 'think', name: 'Think', icon: '💡',
      skills: ['office-hours', 'board'],
      status: 'idle', reportCount: 0,
    },
    {
      id: 'plan', name: 'Plan', icon: '📋',
      skills: ['plan-ceo-review', 'plan-design-review', 'plan-eng-review', 'autoplan'],
      status: 'idle', reportCount: 0,
    },
    {
      id: 'build', name: 'Build', icon: '🔨',
      skills: ['design-consultation', 'design-review'],
      status: 'idle', reportCount: 0,
    },
    {
      id: 'review', name: 'Review', icon: '🔍',
      skills: ['review', 'investigate', 'codex', 'cso'],
      status: 'idle', reportCount: 0,
    },
    {
      id: 'test', name: 'Test', icon: '🧪',
      skills: ['qa', 'qa-only', 'benchmark', 'browse'],
      status: 'idle', reportCount: getQAReports().length + getBenchmarkReports().length,
    },
    {
      id: 'ship', name: 'Ship', icon: '🚀',
      skills: ['ship', 'land-and-deploy', 'document-release'],
      status: 'idle', reportCount: 0,
    },
    {
      id: 'reflect', name: 'Reflect', icon: '🪞',
      skills: ['retro', 'canary'],
      status: 'idle', reportCount: getCanaryReports().length,
    },
  ];

  // Determine stage status from recent skill usage
  for (const stage of stages) {
    let latestRun = '';
    for (const skill of stage.skills) {
      const lr = skillLastRun.get(skill);
      if (lr && lr > latestRun) latestRun = lr;
    }
    if (latestRun) {
      stage.lastRun = latestRun;
      const hoursSince = (Date.now() - new Date(latestRun).getTime()) / (1000 * 60 * 60);
      stage.status = hoursSince < 1 ? 'active' : 'completed';
    }
  }

  return stages;
}

export function getOverviewMetrics(): {
  totalRuns: number;
  successRate: number;
  avgDuration: number;
  activeSkills: number;
  daemonAlive: boolean;
  reportsTotal: number;
  eurekaCount: number;
} {
  const stats = getSkillStats(30);
  const daemon = getDaemonStatus();

  const totalRuns = stats.reduce((s, x) => s + x.runs, 0);
  const totalSuccess = stats.reduce((s, x) => s + Math.round(x.runs * x.successRate / 100), 0);
  const totalDuration = stats.reduce((s, x) => s + x.avgDuration * x.runs, 0);
  const reportsTotal = getQAReports().length + getBenchmarkReports().length
    + getCanaryReports().length + getDesignReports().length;

  return {
    totalRuns,
    successRate: totalRuns > 0 ? Math.round((totalSuccess / totalRuns) * 100) : 0,
    avgDuration: totalRuns > 0 ? Math.round(totalDuration / totalRuns) : 0,
    activeSkills: stats.length,
    daemonAlive: daemon?.alive || false,
    reportsTotal,
    eurekaCount: getEurekaMoments(30).length,
  };
}

export function getGitInfo(): { branch: string; lastCommit: string; remoteSlug: string } {
  let branch = 'unknown';
  let lastCommit = '';
  let remoteSlug = '';

  try {
    const b = Bun.spawnSync(['git', 'branch', '--show-current'], { stdout: 'pipe', stderr: 'pipe', timeout: 2000 });
    if (b.exitCode === 0) branch = b.stdout.toString().trim();
  } catch {}

  try {
    const c = Bun.spawnSync(['git', 'log', '-1', '--format=%h %s'], { stdout: 'pipe', stderr: 'pipe', timeout: 2000 });
    if (c.exitCode === 0) lastCommit = c.stdout.toString().trim();
  } catch {}

  try {
    const r = Bun.spawnSync(['git', 'remote', 'get-url', 'origin'], { stdout: 'pipe', stderr: 'pipe', timeout: 2000 });
    if (r.exitCode === 0) {
      const url = r.stdout.toString().trim();
      const match = url.match(/[:/]([^/]+)\/([^/]+?)(?:\.git)?$/);
      if (match) remoteSlug = `${match[1]}/${match[2]}`;
    }
  } catch {}

  return { branch, lastCommit, remoteSlug };
}

// ─── Helpers ────────────────────────────────────────────────────

function extractDateFromFilename(filename: string): string {
  // Match patterns like 2024-01-15 or 20240115
  const match = filename.match(/(\d{4}-\d{2}-\d{2})/);
  if (match) return match[1];
  const match2 = filename.match(/(\d{8})/);
  if (match2) {
    const d = match2[1];
    return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
  }
  return 'unknown';
}

export function getAnalyticsTimeline(daysBack = 30): { date: string; count: number; skills: Record<string, number> }[] {
  const entries = getSkillUsage(daysBack);
  const dayMap = new Map<string, { count: number; skills: Record<string, number> }>();

  for (const e of entries) {
    if (!e.ts) continue;
    const day = e.ts.slice(0, 10);
    const d = dayMap.get(day) || { count: 0, skills: {} };
    d.count++;
    d.skills[e.skill] = (d.skills[e.skill] || 0) + 1;
    dayMap.set(day, d);
  }

  return Array.from(dayMap.entries())
    .map(([date, data]) => ({ date, ...data }))
    .sort((a, b) => a.date.localeCompare(b.date));
}
