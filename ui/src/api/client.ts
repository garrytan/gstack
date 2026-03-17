const API_BASE = '/api';

async function fetchJSON<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`API ${path}: ${res.status} ${body}`);
  }
  return res.json() as Promise<T>;
}

// --- Types ---

export interface SystemInfo {
  version: string;
  projectDir: string;
  branch: string;
  browseServer: BrowseServerStatus | null;
  sessions: number;
  skills: SkillSummary[];
}

export interface BrowseServerStatus {
  pid: number;
  port: number;
  startedAt: string;
  binaryVersion?: string;
  health?: {
    status: string;
    uptime: number;
    tabs: number;
    currentUrl: string;
  };
}

export interface SkillSummary {
  name: string;
  path: string;
  hasTemplate: boolean;
  commandCount: number;
  invalidCount: number;
  status: 'ok' | 'warning' | 'error';
}

export interface QAReport {
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

export interface QAReportDetail extends QAReport {
  content: string;
  categoryScores: Record<string, number>;
  issues: Array<{
    id: string;
    title: string;
    severity: string;
    category: string;
    url: string;
  }>;
}

export interface EvalRun {
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
  tests: EvalTest[];
}

export interface EvalTest {
  name: string;
  passed: boolean;
  cost_usd: number;
  duration_ms: number;
  turns_used?: number;
  exit_reason?: string;
  detection_rate?: number;
}

export interface EvalSummary {
  totalRuns: number;
  e2eRuns: number;
  judgeRuns: number;
  totalCost: number;
  avgE2ECost: number;
  avgJudgeCost: number;
  avgE2EDuration: number;
  avgDetection: number | null;
  flakyTests: string[];
}

// --- API functions ---

export function getSystemInfo(): Promise<SystemInfo> {
  return fetchJSON('/system');
}

export function getSkills(): Promise<SkillSummary[]> {
  return fetchJSON('/skills');
}

export function getQAReports(): Promise<QAReport[]> {
  return fetchJSON('/qa/reports');
}

export function getQAReport(file: string): Promise<QAReportDetail> {
  return fetchJSON(`/qa/reports/${encodeURIComponent(file)}`);
}

export function getEvalRuns(): Promise<EvalRun[]> {
  return fetchJSON('/evals/runs');
}

export function getEvalSummary(): Promise<EvalSummary> {
  return fetchJSON('/evals/summary');
}

export function getBrowseStatus(): Promise<BrowseServerStatus | null> {
  return fetchJSON('/browse/status');
}

export async function sendBrowseCommand(command: string, args: string[]): Promise<string> {
  const res = await fetch(`${API_BASE}/browse/command`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ command, args }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Browse command failed: ${res.status} ${body}`);
  }
  return res.text();
}
