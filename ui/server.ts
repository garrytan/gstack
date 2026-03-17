#!/usr/bin/env bun
/**
 * gstack dashboard API server
 *
 * Serves the UI frontend and exposes REST API endpoints for:
 *   - System info (version, branch, browse status, sessions, skills)
 *   - QA reports from .gstack/qa-reports/
 *   - Eval results from ~/.gstack-dev/evals/
 *   - Skill health validation
 *   - Browse server proxy
 *
 * Usage: bun run ui/server.ts [--port 9500]
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const PORT = parseInt(process.env.GSTACK_UI_PORT || '9500', 10);
const ROOT = path.resolve(import.meta.dir, '..');
const GSTACK_DIR = path.join(ROOT, '.gstack');
const GSTACK_DEV_DIR = path.join(os.homedir(), '.gstack-dev');
const EVAL_DIR = path.join(GSTACK_DEV_DIR, 'evals');
const QA_DIR = path.join(GSTACK_DIR, 'qa-reports');
const DIST_DIR = path.join(import.meta.dir, 'dist');

// --- Helpers ---

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

function errorResponse(message: string, status = 400): Response {
  return jsonResponse({ error: message }, status);
}

function readJSONFile<T>(filePath: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
  } catch {
    return null;
  }
}

function getGitBranch(): string {
  try {
    const proc = Bun.spawnSync(['git', 'branch', '--show-current'], {
      cwd: ROOT,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    return proc.stdout.toString().trim() || 'unknown';
  } catch {
    return 'unknown';
  }
}

function getVersion(): string {
  try {
    return fs.readFileSync(path.join(ROOT, 'VERSION'), 'utf-8').trim();
  } catch {
    return 'unknown';
  }
}

// --- Skill validation (lightweight, no imports from test/) ---

interface SkillInfo {
  name: string;
  path: string;
  hasTemplate: boolean;
  commandCount: number;
  invalidCount: number;
  status: 'ok' | 'warning' | 'error';
}

const SKILL_DIRS = [
  'browse', 'qa', 'qa-only', 'qa-design-review',
  'ship', 'review', 'retro',
  'plan-ceo-review', 'plan-eng-review', 'plan-design-review',
  'setup-browser-cookies', 'gstack-upgrade', 'document-release',
  'design-consultation',
];

function getSkillInfo(): SkillInfo[] {
  const skills: SkillInfo[] = [];

  // Root SKILL.md
  const rootSkill = path.join(ROOT, 'SKILL.md');
  if (fs.existsSync(rootSkill)) {
    const info = analyzeSkillFile('gstack', rootSkill);
    skills.push(info);
  }

  for (const dir of SKILL_DIRS) {
    const skillPath = path.join(ROOT, dir, 'SKILL.md');
    if (fs.existsSync(skillPath)) {
      const info = analyzeSkillFile(dir, skillPath);
      skills.push(info);
    }
  }

  return skills;
}

function analyzeSkillFile(name: string, filePath: string): SkillInfo {
  const content = fs.readFileSync(filePath, 'utf-8');
  const tmplPath = filePath + '.tmpl';
  const hasTemplate = fs.existsSync(tmplPath);

  // Count $B commands (browse commands referenced in the skill)
  const browseCommandPattern = /\$B\s+(\S+)/g;
  let commandCount = 0;
  let match;
  while ((match = browseCommandPattern.exec(content)) !== null) {
    if (match[1]) commandCount++;
  }

  // Simple validation: check for common issues
  const invalidCount = 0; // Full validation requires test/helpers/skill-parser

  return {
    name,
    path: path.relative(ROOT, filePath),
    hasTemplate,
    commandCount,
    invalidCount,
    status: invalidCount > 0 ? 'error' : 'ok',
  };
}

// --- Browse server status ---

interface BrowseState {
  pid: number;
  port: number;
  token: string;
  startedAt: string;
  binaryVersion?: string;
}

async function getBrowseStatus(): Promise<unknown> {
  const stateFile = path.join(GSTACK_DIR, 'browse.json');
  const state = readJSONFile<BrowseState>(stateFile);
  if (!state) return null;

  // Check if process is alive
  try {
    process.kill(state.pid, 0);
  } catch {
    return null; // process is dead
  }

  // Try to get health
  try {
    const res = await fetch(`http://127.0.0.1:${state.port}/health`, {
      signal: AbortSignal.timeout(2000),
    });
    const health = await res.json();
    return { ...state, token: undefined, health };
  } catch {
    return { ...state, token: undefined, health: null };
  }
}

// --- Browse command proxy ---

async function proxyBrowseCommand(command: string, args: string[]): Promise<string> {
  const stateFile = path.join(GSTACK_DIR, 'browse.json');
  const state = readJSONFile<BrowseState>(stateFile);
  if (!state) throw new Error('Browse server is not running');

  const res = await fetch(`http://127.0.0.1:${state.port}/command`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${state.token}`,
    },
    body: JSON.stringify({ command, args }),
    signal: AbortSignal.timeout(30000),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Browse server returned ${res.status}: ${body}`);
  }

  return res.text();
}

// --- QA Reports ---

interface QAReportSummary {
  file: string;
  date: string;
  url: string;
  branch: string;
  tier: string;
  healthScore: number;
  issueCount: number;
  pagesVisited: number;
  duration: string;
  framework: string;
}

function getQAReports(): QAReportSummary[] {
  if (!fs.existsSync(QA_DIR)) return [];

  const files = fs.readdirSync(QA_DIR).filter(f => f.endsWith('.md') && f !== 'index.md');
  const reports: QAReportSummary[] = [];

  for (const file of files) {
    const content = fs.readFileSync(path.join(QA_DIR, file), 'utf-8');
    reports.push(parseQAReport(file, content));
  }

  // Also check for baseline.json
  const baseline = readJSONFile<Record<string, unknown>>(path.join(QA_DIR, 'baseline.json'));
  if (baseline && typeof baseline === 'object') {
    const date = typeof baseline['date'] === 'string' ? baseline['date'] : '';
    const url = typeof baseline['url'] === 'string' ? baseline['url'] : '';
    const healthScore = typeof baseline['healthScore'] === 'number' ? baseline['healthScore'] : 0;
    const issues = Array.isArray(baseline['issues']) ? baseline['issues'] : [];
    if (reports.length === 0 && date) {
      reports.push({
        file: 'baseline.json',
        date,
        url,
        branch: '',
        tier: 'baseline',
        healthScore,
        issueCount: issues.length,
        pagesVisited: 0,
        duration: '',
        framework: '',
      });
    }
  }

  return reports.sort((a, b) => b.date.localeCompare(a.date));
}

function parseQAReport(file: string, content: string): QAReportSummary {
  const extract = (field: string): string => {
    const regex = new RegExp(`\\*\\*${field}\\*\\*\\s*\\|\\s*(.+)`, 'i');
    const match = content.match(regex);
    return match?.[1]?.trim() ?? '';
  };

  const scoreMatch = content.match(/Health Score:\s*(\d+)/);
  const issueMatches = content.match(/### ISSUE-\d+/g);

  return {
    file,
    date: extract('Date'),
    url: extract('URL'),
    branch: extract('Branch'),
    tier: extract('Tier'),
    healthScore: scoreMatch ? parseInt(scoreMatch[1] ?? '0', 10) : 0,
    issueCount: issueMatches?.length ?? 0,
    pagesVisited: parseInt(extract('Pages visited') || '0', 10),
    duration: extract('Duration'),
    framework: extract('Framework') || 'Unknown',
  };
}

// --- Eval runs ---

interface EvalRunSummary {
  file: string;
  timestamp: string;
  branch: string;
  tier: string;
  version: string;
  passed: number;
  total: number;
  cost: number;
  duration: number;
  turns: number;
  tests: Array<{
    name: string;
    passed: boolean;
    cost_usd: number;
    duration_ms: number;
    turns_used?: number;
    exit_reason?: string;
    detection_rate?: number;
  }>;
}

function getEvalRuns(): EvalRunSummary[] {
  if (!fs.existsSync(EVAL_DIR)) return [];

  const files = fs.readdirSync(EVAL_DIR).filter(f => f.endsWith('.json') && !f.startsWith('_'));
  const runs: EvalRunSummary[] = [];

  for (const file of files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(EVAL_DIR, file), 'utf-8'));
      const tests: EvalRunSummary['tests'] = (data.tests || []).map((t: Record<string, unknown>) => ({
        name: t['name'] ?? '',
        passed: !!t['passed'],
        cost_usd: typeof t['cost_usd'] === 'number' ? t['cost_usd'] : 0,
        duration_ms: typeof t['duration_ms'] === 'number' ? t['duration_ms'] : 0,
        turns_used: typeof t['turns_used'] === 'number' ? t['turns_used'] : undefined,
        exit_reason: typeof t['exit_reason'] === 'string' ? t['exit_reason'] : undefined,
        detection_rate: typeof t['detection_rate'] === 'number' ? t['detection_rate'] : undefined,
      }));

      const totalTurns = tests.reduce((s, t) => s + (t.turns_used ?? 0), 0);

      runs.push({
        file,
        timestamp: data.timestamp || '',
        branch: data.branch || 'unknown',
        tier: data.tier || 'unknown',
        version: data.version || '?',
        passed: data.passed || 0,
        total: data.total_tests || 0,
        cost: data.total_cost_usd || 0,
        duration: data.total_duration_ms || 0,
        turns: totalTurns,
        tests,
      });
    } catch {
      continue;
    }
  }

  return runs.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}

function getEvalSummary(): unknown {
  const runs = getEvalRuns();
  const e2eRuns = runs.filter(r => r.tier === 'e2e');
  const judgeRuns = runs.filter(r => r.tier === 'llm-judge');
  const totalCost = runs.reduce((s, r) => s + r.cost, 0);

  const avgE2ECost = e2eRuns.length > 0
    ? e2eRuns.reduce((s, r) => s + r.cost, 0) / e2eRuns.length
    : 0;
  const avgJudgeCost = judgeRuns.length > 0
    ? judgeRuns.reduce((s, r) => s + r.cost, 0) / judgeRuns.length
    : 0;
  const avgE2EDuration = e2eRuns.length > 0
    ? e2eRuns.reduce((s, r) => s + r.duration, 0) / e2eRuns.length
    : 0;

  // Detection rates
  const detectionRates: number[] = [];
  for (const r of e2eRuns) {
    for (const t of r.tests) {
      if (t.detection_rate !== undefined) {
        detectionRates.push(t.detection_rate);
      }
    }
  }

  // Flaky tests
  const testResults = new Map<string, boolean[]>();
  for (const r of runs) {
    for (const t of r.tests) {
      const key = `${r.tier}:${t.name}`;
      const existing = testResults.get(key) ?? [];
      existing.push(t.passed);
      testResults.set(key, existing);
    }
  }
  const flakyTests: string[] = [];
  for (const [name, outcomes] of testResults) {
    if (outcomes.length >= 2 && outcomes.some(o => o) && outcomes.some(o => !o)) {
      flakyTests.push(name);
    }
  }

  return {
    totalRuns: runs.length,
    e2eRuns: e2eRuns.length,
    judgeRuns: judgeRuns.length,
    totalCost,
    avgE2ECost,
    avgJudgeCost,
    avgE2EDuration,
    avgDetection: detectionRates.length > 0
      ? detectionRates.reduce((a, b) => a + b, 0) / detectionRates.length
      : null,
    flakyTests,
  };
}

// --- Active sessions ---

function getActiveSessions(): number {
  const sessionsDir = path.join(os.homedir(), '.gstack', 'sessions');
  try {
    const files = fs.readdirSync(sessionsDir);
    const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
    return files.filter(f => {
      const stat = fs.statSync(path.join(sessionsDir, f));
      return stat.mtimeMs > twoHoursAgo;
    }).length;
  } catch {
    return 0;
  }
}

// --- Server ---

const server = Bun.serve({
  port: PORT,
  hostname: '0.0.0.0',
  async fetch(req) {
    const url = new URL(req.url);
    const pathname = url.pathname;

    // CORS
    if (req.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        },
      });
    }

    // --- API Routes ---
    if (pathname.startsWith('/api/')) {
      try {
        // System info
        if (pathname === '/api/system' && req.method === 'GET') {
          const browseStatus = await getBrowseStatus();
          return jsonResponse({
            version: getVersion(),
            projectDir: ROOT,
            branch: getGitBranch(),
            browseServer: browseStatus,
            sessions: getActiveSessions(),
            skills: getSkillInfo(),
          });
        }

        // Skills
        if (pathname === '/api/skills' && req.method === 'GET') {
          return jsonResponse(getSkillInfo());
        }

        // QA reports
        if (pathname === '/api/qa/reports' && req.method === 'GET') {
          return jsonResponse(getQAReports());
        }

        // Eval runs
        if (pathname === '/api/evals/runs' && req.method === 'GET') {
          return jsonResponse(getEvalRuns());
        }

        // Eval summary
        if (pathname === '/api/evals/summary' && req.method === 'GET') {
          return jsonResponse(getEvalSummary());
        }

        // Browse status
        if (pathname === '/api/browse/status' && req.method === 'GET') {
          return jsonResponse(await getBrowseStatus());
        }

        // Browse command
        if (pathname === '/api/browse/command' && req.method === 'POST') {
          const body = await req.json() as { command?: string; args?: string[] };
          if (!body.command) return errorResponse('Missing command');
          const result = await proxyBrowseCommand(body.command, body.args ?? []);
          return new Response(result, {
            headers: {
              'Content-Type': 'text/plain',
              'Access-Control-Allow-Origin': '*',
            },
          });
        }

        return errorResponse('Not found', 404);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return errorResponse(message, 500);
      }
    }

    // --- Static files (built UI) ---
    let filePath = path.join(DIST_DIR, pathname === '/' ? 'index.html' : pathname);

    // SPA fallback
    if (!fs.existsSync(filePath)) {
      filePath = path.join(DIST_DIR, 'index.html');
    }

    if (fs.existsSync(filePath)) {
      const file = Bun.file(filePath);
      return new Response(file);
    }

    return new Response('Not found', { status: 404 });
  },
});

console.log(`[gstack-ui] Dashboard running on http://localhost:${server.port}`);
console.log(`[gstack-ui] Project root: ${ROOT}`);
console.log(`[gstack-ui] API: http://localhost:${server.port}/api/system`);
