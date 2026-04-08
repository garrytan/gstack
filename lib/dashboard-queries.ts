/**
 * Dashboard query/transform functions — pure, no I/O.
 *
 * All functions take arrays of Supabase rows (Record<string, unknown>[])
 * and return structured results. Used by both the CLI leaderboard
 * and the shared HTML dashboard.
 */

// --- Types ---

export interface RegressionEntry {
  testName: string;
  previousRate: number;
  currentRate: number;
  delta: number;
}

export interface RegressionResult {
  regressions: RegressionEntry[];
  overallPreviousRate: number | null;
  overallCurrentRate: number | null;
  overallDelta: number;
}

export interface VelocityByUser {
  userId: string;
  email: string;
  shipsThisWeek: number;
  shipsThisMonth: number;
}

export interface VelocityResult {
  byUser: VelocityByUser[];
  teamTotal: { week: number; month: number };
}

export interface CostWeek {
  weekStart: string;
  totalCost: number;
  runs: number;
}

export interface CostTrendResult {
  weekly: CostWeek[];
  totalAllTime: number;
}

export interface LeaderboardEntry {
  userId: string;
  email: string;
  ships: number;
  evalRuns: number;
  sessions: number;
  avgPassRate: number | null;
  totalCost: number;
}

export interface QARepoTrend {
  repoSlug: string;
  scores: Array<{ date: string; score: number }>;
}

export interface QATrendResult {
  byRepo: QARepoTrend[];
}

export interface EvalTestTrend {
  testName: string;
  history: Array<{ timestamp: string; passed: boolean }>;
  passRate: number;
  isFlaky: boolean;
}

export interface EvalTrendResult {
  byTest: EvalTestTrend[];
}

// --- Helpers ---

function safePassRate(passed: unknown, total: unknown): number | null {
  const p = Number(passed) || 0;
  const t = Number(total) || 0;
  return t > 0 ? (p / t) * 100 : null;
}

function weekStart(date: Date): string {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() - d.getUTCDay());
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString().slice(0, 10);
}

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

// --- Query functions ---

/**
 * Detect eval regressions by comparing the most recent run's pass rate
 * against the average of the previous runs.
 */
export function detectRegressions(evalRuns: Record<string, unknown>[]): RegressionResult {
  if (evalRuns.length < 2) {
    return { regressions: [], overallPreviousRate: null, overallCurrentRate: null, overallDelta: 0 };
  }

  // Runs should be sorted by timestamp desc (newest first)
  const latest = evalRuns[0];
  const previous = evalRuns.slice(1);

  const currentRate = safePassRate(latest.passed, latest.total_tests);
  const previousRates = previous
    .map(r => safePassRate(r.passed, r.total_tests))
    .filter((r): r is number => r !== null);

  const previousAvg = previousRates.length > 0
    ? previousRates.reduce((a, b) => a + b, 0) / previousRates.length
    : null;

  const overallDelta = (currentRate !== null && previousAvg !== null)
    ? currentRate - previousAvg
    : 0;

  // Per-test regression detection
  const regressions: RegressionEntry[] = [];
  const latestTests = (latest.tests as any[]) || [];
  const previousTests = previous.flatMap(r => (r.tests as any[]) || []);

  // Group previous test results by name
  const previousByName = new Map<string, boolean[]>();
  for (const t of previousTests) {
    if (!t.name) continue;
    const arr = previousByName.get(t.name) || [];
    arr.push(!!t.passed);
    previousByName.set(t.name, arr);
  }

  for (const t of latestTests) {
    if (!t.name || t.passed) continue; // only look at failures
    const prevResults = previousByName.get(t.name);
    if (!prevResults || prevResults.length === 0) continue;

    const prevPassRate = (prevResults.filter(Boolean).length / prevResults.length) * 100;
    if (prevPassRate > 50) {
      // Was passing >50% of the time, now failed
      regressions.push({
        testName: t.name,
        previousRate: prevPassRate,
        currentRate: 0,
        delta: -prevPassRate,
      });
    }
  }

  return {
    regressions,
    overallPreviousRate: previousAvg,
    overallCurrentRate: currentRate,
    overallDelta,
  };
}

/**
 * Compute shipping velocity grouped by user.
 */
export function computeVelocity(shipLogs: Record<string, unknown>[], windowDays = 30): VelocityResult {
  const weekAgo = daysAgo(7);
  const monthAgo = daysAgo(windowDays);

  const byUser = new Map<string, { email: string; week: number; month: number }>();

  for (const log of shipLogs) {
    const ts = String(log.created_at || log.timestamp || '');
    const userId = String(log.user_id || 'unknown');
    const email = String(log.email || log.user_id || 'unknown');

    if (!byUser.has(userId)) {
      byUser.set(userId, { email, week: 0, month: 0 });
    }
    const entry = byUser.get(userId)!;

    if (ts >= monthAgo) entry.month++;
    if (ts >= weekAgo) entry.week++;
  }

  const sorted = [...byUser.entries()]
    .map(([userId, data]) => ({
      userId,
      email: data.email,
      shipsThisWeek: data.week,
      shipsThisMonth: data.month,
    }))
    .sort((a, b) => b.shipsThisWeek - a.shipsThisWeek || b.shipsThisMonth - a.shipsThisMonth);

  const teamWeek = sorted.reduce((s, u) => s + u.shipsThisWeek, 0);
  const teamMonth = sorted.reduce((s, u) => s + u.shipsThisMonth, 0);

  return {
    byUser: sorted,
    teamTotal: { week: teamWeek, month: teamMonth },
  };
}

/**
 * Compute weekly cost trend from eval runs.
 */
export function computeCostTrend(evalRuns: Record<string, unknown>[]): CostTrendResult {
  const byWeek = new Map<string, { cost: number; runs: number }>();

  for (const run of evalRuns) {
    const ts = run.timestamp || run.created_at;
    if (!ts) continue;

    const ws = weekStart(new Date(String(ts)));
    const entry = byWeek.get(ws) || { cost: 0, runs: 0 };
    entry.cost += Number(run.total_cost_usd) || 0;
    entry.runs++;
    byWeek.set(ws, entry);
  }

  const weekly = [...byWeek.entries()]
    .map(([ws, data]) => ({ weekStart: ws, totalCost: data.cost, runs: data.runs }))
    .sort((a, b) => b.weekStart.localeCompare(a.weekStart));

  const totalAllTime = evalRuns.reduce((s, r) => s + (Number(r.total_cost_usd) || 0), 0);

  return { weekly, totalAllTime };
}

// NOTE: The dashboard UI (supabase/functions/dashboard/ui.ts renderLeaderboard())
// has a parallel client-side implementation of this logic. If you change the
// aggregation or sorting here, update the dashboard JS too.
/**
 * Compute team leaderboard for the current week.
 */
export function computeLeaderboard(opts: {
  evalRuns: Record<string, unknown>[];
  shipLogs: Record<string, unknown>[];
  sessions: Record<string, unknown>[];
}): LeaderboardEntry[] {
  const { evalRuns, shipLogs, sessions } = opts;
  const weekAgo = daysAgo(7);

  const users = new Map<string, LeaderboardEntry>();

  function getUser(userId: string, email: string): LeaderboardEntry {
    if (!users.has(userId)) {
      users.set(userId, { userId, email, ships: 0, evalRuns: 0, sessions: 0, avgPassRate: null, totalCost: 0 });
    }
    return users.get(userId)!;
  }

  // Count eval runs this week
  const passRates = new Map<string, number[]>();
  for (const r of evalRuns) {
    const ts = String(r.timestamp || r.created_at || '');
    if (ts < weekAgo) continue;
    const userId = String(r.user_id || 'unknown');
    const email = String(r.email || r.user_id || 'unknown');
    const user = getUser(userId, email);
    user.evalRuns++;
    user.totalCost += Number(r.total_cost_usd) || 0;

    const rate = safePassRate(r.passed, r.total_tests);
    if (rate !== null) {
      const arr = passRates.get(userId) || [];
      arr.push(rate);
      passRates.set(userId, arr);
    }
  }

  // Count ships this week
  for (const log of shipLogs) {
    const ts = String(log.created_at || log.timestamp || '');
    if (ts < weekAgo) continue;
    const userId = String(log.user_id || 'unknown');
    const email = String(log.email || log.user_id || 'unknown');
    const user = getUser(userId, email);
    user.ships++;
  }

  // Count sessions this week
  for (const s of sessions) {
    const ts = String(s.started_at || s.created_at || '');
    if (ts < weekAgo) continue;
    const userId = String(s.user_id || 'unknown');
    const email = String(s.email || s.user_id || 'unknown');
    const user = getUser(userId, email);
    user.sessions++;
  }

  // Compute avg pass rates
  for (const [userId, rates] of passRates) {
    const user = users.get(userId);
    if (user && rates.length > 0) {
      user.avgPassRate = rates.reduce((a, b) => a + b, 0) / rates.length;
    }
  }

  // Sort by ships (primary), then eval runs, then sessions
  return [...users.values()].sort((a, b) =>
    b.ships - a.ships || b.evalRuns - a.evalRuns || b.sessions - a.sessions
  );
}

/**
 * Compute QA health score trends grouped by repo.
 */
export function computeQATrend(qaReports: Record<string, unknown>[]): QATrendResult {
  const byRepo = new Map<string, Array<{ date: string; score: number }>>();

  for (const r of qaReports) {
    const repoSlug = String(r.repo_slug || 'unknown');
    const date = String(r.created_at || '').slice(0, 10);
    const score = Number(r.health_score) || 0;

    if (!byRepo.has(repoSlug)) byRepo.set(repoSlug, []);
    byRepo.get(repoSlug)!.push({ date, score });
  }

  // Sort each repo's scores by date descending
  const result: QARepoTrend[] = [];
  for (const [repoSlug, scores] of byRepo) {
    scores.sort((a, b) => b.date.localeCompare(a.date));
    result.push({ repoSlug, scores });
  }

  return { byRepo: result.sort((a, b) => a.repoSlug.localeCompare(b.repoSlug)) };
}

/**
 * Compute per-test pass rate trends and flaky test detection.
 */
export function computeEvalTrend(evalRuns: Record<string, unknown>[]): EvalTrendResult {
  const byTest = new Map<string, Array<{ timestamp: string; passed: boolean }>>();

  // Runs should be sorted by timestamp desc; we process all of them
  for (const run of evalRuns) {
    const ts = String(run.timestamp || run.created_at || '');
    const tests = (run.tests as any[]) || [];

    for (const t of tests) {
      if (!t.name) continue;
      if (!byTest.has(t.name)) byTest.set(t.name, []);
      byTest.get(t.name)!.push({ timestamp: ts, passed: !!t.passed });
    }
  }

  const result: EvalTestTrend[] = [];
  for (const [testName, history] of byTest) {
    // Sort by timestamp ascending for trend display
    history.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

    const passCount = history.filter(h => h.passed).length;
    const passRate = history.length > 0 ? (passCount / history.length) * 100 : 0;

    // Flaky = has both passes and failures, and pass rate between 20-80%
    const isFlaky = history.length >= 3 && passRate > 20 && passRate < 80;

    result.push({ testName, history, passRate, isFlaky });
  }

  // Sort: flaky first, then by pass rate ascending (worst first)
  return {
    byTest: result.sort((a, b) => {
      if (a.isFlaky !== b.isFlaky) return a.isFlaky ? -1 : 1;
      return a.passRate - b.passRate;
    }),
  };
}
