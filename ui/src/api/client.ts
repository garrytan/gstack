const API_BASE = '/api';

let _isApiAvailable: boolean | null = null;

async function fetchJSON<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`API ${path}: ${res.status} ${body}`);
  }
  _isApiAvailable = true;
  return res.json() as Promise<T>;
}

async function fetchWithFallback<T>(path: string, fallback: T): Promise<T> {
  try {
    return await fetchJSON<T>(path);
  } catch {
    _isApiAvailable = false;
    return fallback;
  }
}

export function isApiConnected(): boolean | null {
  return _isApiAvailable;
}

// --- Types ---

export interface SystemInfo {
  version: string;
  projectDir: string;
  branch: string;
  browseServer: BrowseServerStatus | null;
  sessions: number;
  skills: SkillSummary[];
  _demo?: boolean;
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

// --- Demo data ---

const DEMO_SKILLS: SkillSummary[] = [
  { name: 'gstack', path: 'SKILL.md', hasTemplate: true, commandCount: 85, invalidCount: 0, status: 'ok' },
  { name: 'browse', path: 'browse/SKILL.md', hasTemplate: true, commandCount: 49, invalidCount: 0, status: 'ok' },
  { name: 'qa', path: 'qa/SKILL.md', hasTemplate: true, commandCount: 35, invalidCount: 0, status: 'ok' },
  { name: 'qa-only', path: 'qa-only/SKILL.md', hasTemplate: true, commandCount: 31, invalidCount: 0, status: 'ok' },
  { name: 'qa-design-review', path: 'qa-design-review/SKILL.md', hasTemplate: true, commandCount: 25, invalidCount: 0, status: 'ok' },
  { name: 'ship', path: 'ship/SKILL.md', hasTemplate: true, commandCount: 1, invalidCount: 0, status: 'ok' },
  { name: 'review', path: 'review/SKILL.md', hasTemplate: true, commandCount: 1, invalidCount: 0, status: 'ok' },
  { name: 'retro', path: 'retro/SKILL.md', hasTemplate: true, commandCount: 1, invalidCount: 0, status: 'ok' },
  { name: 'plan-ceo-review', path: 'plan-ceo-review/SKILL.md', hasTemplate: true, commandCount: 1, invalidCount: 0, status: 'ok' },
  { name: 'plan-eng-review', path: 'plan-eng-review/SKILL.md', hasTemplate: true, commandCount: 1, invalidCount: 0, status: 'ok' },
  { name: 'plan-design-review', path: 'plan-design-review/SKILL.md', hasTemplate: true, commandCount: 21, invalidCount: 0, status: 'ok' },
  { name: 'setup-browser-cookies', path: 'setup-browser-cookies/SKILL.md', hasTemplate: true, commandCount: 4, invalidCount: 0, status: 'ok' },
  { name: 'gstack-upgrade', path: 'gstack-upgrade/SKILL.md', hasTemplate: true, commandCount: 0, invalidCount: 0, status: 'ok' },
  { name: 'document-release', path: 'document-release/SKILL.md', hasTemplate: true, commandCount: 1, invalidCount: 0, status: 'ok' },
  { name: 'design-consultation', path: 'design-consultation/SKILL.md', hasTemplate: true, commandCount: 4, invalidCount: 0, status: 'ok' },
];

const DEMO_SYSTEM: SystemInfo = {
  version: '0.3.3',
  projectDir: '/path/to/gstack',
  branch: 'main',
  browseServer: null,
  sessions: 0,
  skills: DEMO_SKILLS,
  _demo: true,
};

const DEMO_QA: QAReport[] = [
  { file: 'demo-1.md', date: '2026-03-15', url: 'https://example.com', branch: 'main', tier: 'full', healthScore: 82, issueCount: 3, pagesVisited: 12, duration: '4m 32s', framework: 'Next.js' },
  { file: 'demo-2.md', date: '2026-03-10', url: 'https://staging.example.com', branch: 'feature/auth', tier: 'quick', healthScore: 65, issueCount: 7, pagesVisited: 8, duration: '2m 15s', framework: 'React' },
];

const DEMO_EVALS: EvalRun[] = [
  {
    file: 'demo-1.json', timestamp: '2026-03-15T10:30:00Z', branch: 'main', tier: 'e2e', version: '0.3.3',
    passed: 8, total: 10, cost: 1.24, duration: 45000, turns: 42,
    tests: [
      { name: 'goto-and-snapshot', passed: true, cost_usd: 0.12, duration_ms: 4500, turns_used: 4 },
      { name: 'form-fill', passed: true, cost_usd: 0.15, duration_ms: 5200, turns_used: 5 },
      { name: 'cookie-import', passed: true, cost_usd: 0.10, duration_ms: 3800, turns_used: 3 },
      { name: 'multi-tab', passed: false, cost_usd: 0.18, duration_ms: 6000, turns_used: 6, exit_reason: 'timeout' },
      { name: 'screenshot-diff', passed: true, cost_usd: 0.11, duration_ms: 4200, turns_used: 4 },
      { name: 'console-capture', passed: true, cost_usd: 0.09, duration_ms: 3500, turns_used: 3 },
      { name: 'network-intercept', passed: true, cost_usd: 0.14, duration_ms: 4800, turns_used: 5 },
      { name: 'dialog-handling', passed: true, cost_usd: 0.08, duration_ms: 3200, turns_used: 3 },
      { name: 'viewport-resize', passed: true, cost_usd: 0.13, duration_ms: 4500, turns_used: 4 },
      { name: 'pdf-export', passed: false, cost_usd: 0.14, duration_ms: 5300, turns_used: 5, exit_reason: 'assertion' },
    ],
  },
  {
    file: 'demo-2.json', timestamp: '2026-03-12T14:00:00Z', branch: 'main', tier: 'llm-judge', version: '0.3.2',
    passed: 5, total: 5, cost: 0.85, duration: 32000, turns: 25,
    tests: [
      { name: 'qa-report-quality', passed: true, cost_usd: 0.18, duration_ms: 6500, turns_used: 5, detection_rate: 0.92 },
      { name: 'issue-description', passed: true, cost_usd: 0.16, duration_ms: 6200, turns_used: 5, detection_rate: 0.88 },
      { name: 'severity-accuracy', passed: true, cost_usd: 0.17, duration_ms: 6800, turns_used: 5, detection_rate: 0.95 },
      { name: 'repro-steps', passed: true, cost_usd: 0.15, duration_ms: 5800, turns_used: 5, detection_rate: 0.85 },
      { name: 'screenshot-relevance', passed: true, cost_usd: 0.19, duration_ms: 6700, turns_used: 5, detection_rate: 0.90 },
    ],
  },
];

const DEMO_EVAL_SUMMARY: EvalSummary = {
  totalRuns: 2, e2eRuns: 1, judgeRuns: 1, totalCost: 2.09,
  avgE2ECost: 1.24, avgJudgeCost: 0.85, avgE2EDuration: 45000,
  avgDetection: 0.90, flakyTests: ['multi-tab'],
};

// --- API functions ---

export function getSystemInfo(): Promise<SystemInfo> {
  return fetchWithFallback('/system', DEMO_SYSTEM);
}

export function getSkills(): Promise<SkillSummary[]> {
  return fetchWithFallback('/skills', DEMO_SKILLS);
}

export function getQAReports(): Promise<QAReport[]> {
  return fetchWithFallback('/qa/reports', DEMO_QA);
}

export function getQAReport(file: string): Promise<QAReportDetail> {
  return fetchJSON(`/qa/reports/${encodeURIComponent(file)}`);
}

export function getEvalRuns(): Promise<EvalRun[]> {
  return fetchWithFallback('/evals/runs', DEMO_EVALS);
}

export function getEvalSummary(): Promise<EvalSummary> {
  return fetchWithFallback('/evals/summary', DEMO_EVAL_SUMMARY);
}

export function getBrowseStatus(): Promise<BrowseServerStatus | null> {
  return fetchWithFallback('/browse/status', null);
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
